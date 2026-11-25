import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let mcp,
  calls = 0,
  prompt;
let rpcId = 0;
const send = (x) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...x }) + "\n");
const update = (sessionUpdate, text) =>
  send({
    method: "session/update",
    params: {
      sessionId: "native-1",
      update: { sessionUpdate, content: { type: "text", text } },
    },
  });
async function post(method, params, extra = {}) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(mcp.headers.map((h) => [h.name, h.value])),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return response;
}
const invoke = async (name, args) =>
  (await (await post("tools/call", { name, arguments: args })).json()).result;
async function handle({ id, method, params }) {
  const reply = (result) => send({ id, result });
  if (method === "initialize") return reply({ protocolVersion: 1 });
  if (method === "session/new") {
    [mcp] = params.mcpServers;
    const stage = process.argv[process.argv.indexOf("--gemini-dir") + 1];
    const agent = await readFile(
      join(stage, "config/agents/pocket-pi-bridge/agent.md"),
      "utf8",
    );
    if (
      !agent.includes("tools: []") ||
      !agent.includes(mcp.url) ||
      !agent.includes("excludeDefaultComponents: true")
    )
      throw new Error("not restricted");
    const unauthorized = await post(
      "tools/list",
      {},
      { "x-bridge-token": "bogus" },
    );
    const crossSite = await post(
      "tools/list",
      {},
      { Origin: "https://unrelated.example" },
    );
    if (unauthorized.status !== 401 || crossSite.status !== 403)
      throw new Error("MCP auth failed");
    await post("initialize", { protocolVersion: "2025-06-18" });
    return reply({ sessionId: "native-1" });
  }
  if (method === "session/set_config_option") return reply({});
  if (method === "session/cancel")
    return send({ id: prompt, result: { stopReason: "cancelled" } });
  if (method !== "session/prompt") return;
  calls++;
  const input = params.prompt
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  prompt = id;
  if (input.includes("cancel-test")) return;
  const simulated = {
    auth: { code: -32000, message: "Authentication required", data: "internal details" },
    quota: { code: -32000, message: "Provider error", data: { status: "RESOURCE_EXHAUSTED", detail: "internal details" } },
    rate: { code: 429, message: "internal details" },
  }[/error-test:(auth|quota|rate)/.exec(input)?.[1]];
  if (simulated) return send({ id, error: simulated });
  const listed = (await (await post("tools/list", {})).json()).result.tools.map(
    (x) => x.name,
  );
  if (params.prompt.at(-1)?.text === "long-history-test") {
    const history = params.prompt.find((b) => b.type === "text" && b.text.startsWith("Pi Pocket history"));
    if (!history) throw new Error("Expected a Pi history digest");
    const json = history.text.slice(history.text.indexOf("\n") + 1);
    const { entries, omittedEntryRanges } = JSON.parse(json);
    const preview = ({ text, ...fields }) => ({ ...fields, start: text.slice(0, 80), end: text.slice(-80) });
    update("agent_message_chunk", JSON.stringify({
      bytes: Buffer.byteLength(json),
      indices: entries.map(({ entry }) => entry),
      head: preview(entries[0]),
      newest: entries.at(-1),
      large: preview(entries.at(-2)),
      omittedEntryRanges,
    }));
  } else if (input.includes("Pi Pocket history") && input.includes("image-test")) {
    const images = params.prompt.filter((block) => block.type === "image");
    // One prompt in this ACP process: a reused session would have calls > 1.
    if (calls !== 1 || images.length !== 1 || images[0].mimeType !== "image/png" || images[0].uri)
      throw new Error("Expected a fresh ACP session with an inline PNG");
    update("agent_message_chunk", `inline image: ${images[0].data}`);
  } else if (input === "inline-ask-test") {
    const images = params.prompt.filter((block) => block.type === "image");
    if (listed.length || images.length !== 1 || images[0].mimeType !== "image/png")
      throw new Error("Expected an inline PNG and no tools");
    update("agent_message_chunk", `ask image: ${images[0].data}`);
  } else if (
    /fixture\.txt|round-trip/.test(input) &&
    !input.includes("Pi Pocket history")
  ) {
    if (!listed.includes("read") || listed.includes("removed_read"))
      throw new Error("bad tool catalog");
    update("agent_thought_chunk", "Need to read.");
    const invalid = await invoke("removed_read", {});
    if (!invalid.isError) throw new Error("Tool not blocked");
    let response = await invoke("read", { path: "fixture.txt" });
    const wait = /^STILL RUNNING.* (agy_[a-f0-9]+)\.$/.exec(
      response.content[0].text,
    );
    if (wait)
      response = await invoke("bridge_poll_result", { callId: wait[1] });
    update("agent_message_chunk", `read result: ${response.content[0].text}`);
  } else {
    update(
      "agent_message_chunk",
      `turn ${calls}; ${input.includes("Pi Pocket history") ? "with history" : "no history"}`,
    );
  }
  reply({
    stopReason: "end_turn",
    usage: {
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      thoughtTokens: 7,
    },
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  void handle(JSON.parse(line)).catch(() => {
    process.exitCode = 1;
    process.stdin.destroy();
  });
}
