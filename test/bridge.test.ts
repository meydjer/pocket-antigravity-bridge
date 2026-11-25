import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createBridge } from "../antigravity-bridge/provider.ts";
import { removeStaleAcpHomes } from "../antigravity-bridge/acp.ts";
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
  await mkdir(join(dir, "antigravity-cli"));
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
    stageDir: join(dir, "work"),
    async close() {
      bridge.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function continuation(
  history: Message[],
  assistant: Message,
  content: Extract<Message, { role: "toolResult" }>["content"] = [
    { type: "text", text: "synthetic-fixture-content" },
  ],
): Message[] {
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
      content,
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

test("native gate accepts only real offloaded media and uses the hook conversation ID", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pocket-agy-media-"));
  try {
    const id = "12345678-9abc-4def-8999-123456789abc";
    const otherId = "22345678-9abc-4def-8999-123456789abc";
    const appData = join(tmp, "app");
    const alias = join(tmp, "alias");
    const suffix = join("brain", id, ".system_generated", "steps", "2");
    const step = join(appData, suffix);
    const image = join(step, "media_0.png");
    const outside = join(tmp, "media_0.png");
    const other = join(appData, "brain", otherId, ".system_generated/steps/2");
    await mkdir(step, { recursive: true });
    await mkdir(other, { recursive: true });
    await symlink(appData, alias);
    await symlink(outside, join(step, "media_link.png"));
    await mkdir(join(step, "media_dir.png"));
    const wrongPaths = [join(step, "image.png"), join(step, "media_0.txt"), join(appData, "media_0.png")];
    for (const file of [image, outside, join(other, "media_0.png"), ...wrongPaths])
      await writeFile(file, "fixture");
    const script = join(import.meta.dirname, "../antigravity-bridge/native-gate.cjs");
    const check = (input: string, decision: string) => {
      const result = spawnSync(process.execPath, [script, appData, alias], { input, encoding: "utf8", timeout: 3000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, decision, input);
    };
    const call = (args: object, conversationId: unknown = id) =>
      JSON.stringify({ toolCall: { name: "view_file", args }, conversationId });
    check(call({ Path: image }), "allow");
    check(call({ AbsolutePath: join(alias, suffix, "media_0.png") }), "allow");
    check(JSON.stringify({ toolCall: { name: "view_file", args: { Path: image } } }), "allow");
    check(call({ Path: image }, otherId), "deny");
    check(call({ Path: image }, null), "deny");
    for (const path of [outside, join(other, "media_0.png"), ...wrongPaths, "media_0.png", step + "/../2/media_0.png", step + "/media_link.png", step + "/media_dir.png"])
      check(call({ Path: path }), "deny");
    for (const args of [{}, { Path: [image] }, { Path: image, StartLine: 1 }, { Path: image, AbsolutePath: image }, { path: image }])
      check(call(args), "deny");
    check('{"toolCall":', "deny");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("startup cleanup removes only old ACP work folders and does not follow symlinks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pocket-agy-stale-"));
  try {
    const stage = join(tmp, "work");
    const outside = join(tmp, "keep");
    const stale = join(stage, "acp-Old001");
    const fresh = join(stage, "acp-New001");
    const unknown = join(stage, "acp-unrelated");
    for (const folder of [stale, fresh, unknown, outside]) await mkdir(folder, { recursive: true });
    await writeFile(join(outside, "keep"), "fixture");
    await symlink(outside, join(stale, "antigravity-cli"));
    await symlink(outside, join(stage, "acp-Link01"));
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    for (const folder of [stale, unknown, outside]) await utimes(folder, old, old);
    await removeStaleAcpHomes(stage);
    assert.deepEqual((await readdir(stage)).sort(), ["acp-Link01", "acp-New001", "acp-unrelated"]);
    assert.deepEqual(await readdir(outside), ["keep"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("model discovery groups verified effort tiers, excludes retired models, and clamps effort", () => {
  const all = entriesFromRaw(
    "gemini-3.8-flash-xhigh\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash\nclaude-sonnet-4-6\tClaude\ngpt-oss-120b-medium\nAvailable models:",
  );
  assert.deepEqual(
    all.map((m) => m.id),
    ["gemini-3-8-flash", "claude-sonnet-4-6"],
  );
  assert.equal(toAgyEffort("medium", all[0].efforts!), "high");
  assert.equal(toAgyEffort(undefined, all[0].efforts!), "low");
  assert.equal(toAgyEffort("xhigh", all[0].efforts!), "xhigh");
  assert.equal(toPiModel(all[0]).thinkingLevelMap?.xhigh, "xhigh");
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

for (const compacted of [false, true])
  test(`ACP restores the ${compacted ? "compaction summary" : "first user task"} and recent history from valid JSON`, async () => {
    const { bridge, close } = await setup();
    try {
      const start = compacted
        ? "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
        : "Original task: keep the first message.";
      const end = compacted ? "\n</summary>" : "End of task.";
      const escaped = '\n"quoted" \u0000 🌙 \\ line';
      const anchor = start + escaped.repeat(compacted ? 25_000 : 500) + end;
      const large = {
        role: "toolResult",
        toolName: "read",
        toolCallId: "old-read",
        isError: false,
        timestamp: 0,
        content: [{
          type: "text",
          text: "Beginning of tool result." + escaped.repeat(6_000) + "End of tool result.",
        }],
      } satisfies Message;
      const newest = 'Newest prior message: "🌙"\n\u0000';
      const prior = [
        user(anchor),
        ...Array.from({ length: 200 }, (_, i) => user(`Older message ${i}.` + escaped.repeat(200))),
        large,
        user(newest),
      ];
      const reply = await bridge.streamSimple(
        model,
        transcript([...sys, ...prior, user("long-history-test")]),
        { sessionId: "long-history" },
      ).result();
      assert.equal(reply.stopReason, "stop", reply.errorMessage ?? "");
      const report = reply.content[0];
      assert.equal(report.type, "text");
      const digest = JSON.parse(report.text);
      assert.ok(digest.bytes > 150_000 && digest.bytes <= 400_000, `Digest bytes: ${digest.bytes}`);
      assert.equal(digest.head.entry, 1);
      assert.equal(digest.head.role, "user");
      assert.equal(digest.head.start, anchor.slice(0, 80));
      assert.equal(digest.head.end, anchor.slice(-80));
      assert.equal(Boolean(digest.head.omittedTextCharacters), compacted);
      assert.deepEqual(digest.newest, { entry: prior.length, role: "user", text: newest });
      assert.equal(digest.large.start.startsWith("Beginning of tool result."), true);
      assert.equal(digest.large.end.endsWith("End of tool result."), true);
      assert.equal(digest.large.tool, "read");
      assert.equal(digest.large.failed, false);
      assert.ok(digest.large.omittedTextCharacters > 0);
      const tailStart = digest.indices[1];
      assert.ok(tailStart > 2 && tailStart < prior.length - 1);
      assert.deepEqual(
        digest.indices.slice(1),
        Array.from({ length: prior.length - tailStart + 1 }, (_, i) => tailStart + i),
      );
      assert.deepEqual(digest.omittedEntryRanges, [[2, tailStart - 1]]);
    } finally {
      await close();
    }
  });

for (const scenario of ["same turn", "gate denial", "restart"]) {
  test("a Pi image result reaches the model: " + scenario, async () => {
    const { bridge, build, close, stageDir } = await setup();
    const opts = { sessionId: "image" };
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
    const restarted = scenario === "restart" ? build() : undefined;
    try {
      const history = [...sys, user("round-trip image-test" + (scenario === "gate denial" ? " deny-media" : ""))];
      const first = await bridge.streamSimple(model, transcript(history), opts).result();
      const messages = continuation(history, first, [{ type: "image", mimeType: "image/png", data }]);
      if (restarted) bridge.dispose();
      const answer = await (restarted ?? bridge).streamSimple(model, transcript(messages), opts).result();
      assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
      const prefix = scenario === "same turn" ? "MCP media: " : "inline image: ";
      assert.deepEqual(answer.content, [{ type: "text", text: prefix + data }]);
      bridge.dispose();
      restarted?.dispose();
      for (let attempt = 0; attempt < 100 && (await readdir(stageDir)).length; attempt++)
        await wait(20);
      assert.deepEqual(await readdir(stageDir), []);
    } finally {
      restarted?.dispose();
      await close();
    }
  });
}

test("a compaction during a Pi tool call recovers from Pi history", async () => {
  const { bridge, close } = await setup();
  const opts = { sessionId: "compaction" };
  try {
    const history = [...sys, user("round-trip")];
    const call = await bridge.streamSimple(model, transcript(history), opts).result();
    assert.equal(call.stopReason, "toolUse", call.errorMessage ?? "");
    // Pi compacts while the tool runs: the prefix before the call changes.
    const compacted = [...sys, user("Summary of the earlier work. round-trip")];
    const answer = await bridge
      .streamSimple(model, transcript(continuation(compacted, call)), opts)
      .result();
    assert.notEqual(answer.stopReason, "error", answer.errorMessage ?? "");
  } finally {
    await close();
  }
});

for (const [scenario, guidance] of [
  ["auth", /Run `agy` in a terminal on the server to sign in/],
  ["quota", /quota or rate limit.*Wait and retry/],
  ["rate", /quota or rate limit.*Wait and retry/],
] as const) {
  test(`ACP ${scenario} error ends the turn with guidance`, async () => {
    const { bridge, close } = await setup();
    try {
      const reply = await bridge.streamSimple(model, transcript([user(`error-test:${scenario}`)]), { sessionId: scenario }).result();
      assert.equal(reply.stopReason, "error");
      assert.match(reply.errorMessage ?? "", guidance);
      assert.doesNotMatch(reply.errorMessage ?? "", /internal details/);
    } finally {
      await close();
    }
  });
}

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
