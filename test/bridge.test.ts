import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createBridge } from "../antigravity-bridge/provider.ts";
import {
  entriesFromRaw,
  FALLBACK_MODELS,
  toAgyEffort,
  toPiModel,
} from "../antigravity-bridge/models.ts";

const entry = FALLBACK_MODELS.find((x) => x.id === "gemini-3-8-flash")!;
const model = toPiModel(entry);
const tools = ["read", "removed_read"].map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: { path: { type: "string" } } },
}));
const sys: Message[] = [
  {
    role: "system",
    content: "Synthetic Pi system instructions.",
    toolsAdded: tools,
    timestamp: 0,
  },
  {
    role: "system",
    content: "",
    toolsRemoved: [{ name: "removed_read" }],
    timestamp: 0,
  },
];
const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: Date.now(),
});
const transcript = (messages: Message[]) => ({ messages }) as TranscriptContext;
async function setup(pollMs = 500) {
  const dir = await mkdtemp(join(tmpdir(), "pocket-agy-test-"));
  const build = () =>
    createBridge(
      {
        bin: process.execPath,
        binArgs: [join(import.meta.dirname, "fake-acp.mjs")],
        stageDir: join(dir, "work"),
        geminiDir: dir,
        pollMs,
        turnMs: 5000,
      },
      new Map([[entry.id, entry]]),
    );
  const bridge = build();
  return {
    bridge,
    build,
    async close() {
      bridge.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function continuation(history: Message[], assistant: Message): Message[] {
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.stopReason, "toolUse");
  const tool = assistant.content.find((b) => b.type === "toolCall")!;
  assert.ok(tool);
  assert.equal(tool.name, "read");
  assert.deepEqual(tool.arguments, { path: "fixture.txt" });
  return [
    ...history,
    assistant,
    {
      role: "toolResult",
      toolName: tool.name,
      toolCallId: tool.id,
      isError: false,
      timestamp: Date.now(),
      content: [{ type: "text", text: "synthetic-fixture-content" }],
    },
  ];
}

test("carrier gate permits private MCP and denies native and foreign calls", () => {
  const script = join(
    import.meta.dirname,
    "../antigravity-bridge/native-gate.cjs",
  );
  for (const [toolCall, expected] of [
    [{ name: "mcp_pi-bridge_read" }, "allow"],
    [{ name: "call_mcp_tool", args: { ServerName: "pi-bridge" } }, "allow"],
    [{ name: "call_mcp_tool", args: { ServerName: "other" } }, "deny"],
    [{ name: "run_command" }, "deny"],
    [null, "deny"],
  ] as const) {
    const processResult = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ toolCall }),
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(processResult.status, 0, processResult.stderr);
    assert.equal(JSON.parse(processResult.stdout).decision, expected);
  }
});

test("model discovery groups verified effort tiers, excludes retired models, and clamps effort", () => {
  const all = entriesFromRaw(
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash\nclaude-sonnet-4-6\tClaude\ngpt-oss-120b-medium\nAvailable models:",
  );
  assert.deepEqual(
    all.map((m) => m.id),
    ["gemini-3-8-flash", "claude-sonnet-4-6"],
  );
  assert.equal(toAgyEffort("medium", all[0].efforts!), "high");
  assert.equal(toAgyEffort(undefined, all[0].efforts!), "low");
});

for (const slow of [false, true])
  test(`mocked ACP -> authenticated MCP -> Pi read -> ${slow ? "poll" : "direct result"}`, async () => {
    const { bridge, build, close } = await setup(slow ? 12 : 500);
    const opts = { sessionId: "conversation-1" };
    try {
      const history = [...sys, user("round-trip")];
      const stream = bridge.streamSimple(model, transcript(history), opts);
      const events = [];
      for await (const e of stream) events.push(e.type);
      const call = await stream.result();
      assert.ok(events.includes("thinking_delta"));
      assert.ok(events.includes("toolcall_end"));
      if (slow) await wait(80);
      const messages = continuation(history, call);
      const answer = await bridge
        .streamSimple(model, transcript(messages), opts)
        .result();
      assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
      assert.deepEqual(answer.content, [
        { type: "text", text: "read result: synthetic-fixture-content" },
      ]);
      assert.equal(answer.usage.totalTokens, 168);
      const next = [...messages, answer, user("follow-up")];
      const resumed = await bridge
        .streamSimple(model, transcript(next), opts)
        .result();
      assert.deepEqual(resumed.content, [
        { type: "text", text: "turn 2; no history" },
      ]);
      bridge.dispose();
      const newBridge = build();
      try {
        const recovered = await newBridge
          .streamSimple(
            model,
            transcript([...next, resumed, user("after restart")]),
            opts,
          )
          .result();
        assert.deepEqual(recovered.content, [
          { type: "text", text: "turn 1; with history" },
        ]);
      } finally {
        newBridge.dispose();
      }
    } finally {
      await close();
    }
  });

test("an aborted stream settles and disposes its ACP connection", async () => {
  const { bridge, close } = await setup();
  try {
    const control = new AbortController();
    const stream = bridge.streamSimple(
      model,
      transcript([...sys, user("cancel-test")]),
      { sessionId: "cancel", signal: control.signal },
    );
    setTimeout(() => control.abort(), 250);
    assert.equal((await stream.result()).stopReason, "aborted");
  } finally {
    await close();
  }
});
