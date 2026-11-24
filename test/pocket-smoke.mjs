// Opt-in live test. The default uses a mock and no account or quota.
import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const live = process.argv.includes("--live");
const pocket =
  process.env.PI_POCKET_SOURCE ??
  join(process.env.HOME, ".local/share/pi-pocket-source");
const {
  cleanUp,
  context,
  loadTools,
  openApp,
  owner,
  root,
  scriptedModel,
  until,
  work,
} = await import(pathToFileURL(join(pocket, "test/helpers.ts")));
const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const file = "antigravity-bridge.ts";
const id = "gemini-3-8-flash";
const fixture = "synthetic-fixture-content";
await mkdir(dropIns, { recursive: true });
await cp(join(import.meta.dirname, "..", file), join(dropIns, file));
await cp(
  join(import.meta.dirname, "../antigravity-bridge"),
  join(dropIns, "antigravity-bridge"),
  { recursive: true },
);
await writeFile(join(work, "fixture.txt"), fixture + "\n");
const guard = "fixture-guard.ts";
await writeFile(
  join(dropIns, guard),
  `
    import { defineExtension, hook, ToolTask, GenerationTask } from "@earendil-works/pi-durable";
    export default () => defineExtension({ name: "fixture-guard", hooks: [
        hook(ToolTask, { beforeTool: (call) => call.name === "read" && call.arguments.path === "fixture.txt"
            ? undefined : { block: "This test permits only a read of fixture.txt." } }),
        hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: messages.map((m) =>
            m.role === "system" && m.toolsAdded ? { ...m, toolsAdded: m.toolsAdded.filter((t) => t.name === "read") } : m) }) }),
    ] });
`,
);
const conf = join(dataDir, "antigravity-bridge");
await mkdir(conf);
let binary = process.env.AGY_BINARY ?? "agy";
if (!live) {
  process.env.HOME = join(root, "home");
  binary = join(root, "fake-agy");
  await writeFile(
    binary,
    `#!/bin/sh\ncase "$1" in\nmodels) printf '%s\\n' gemini-3.8-flash-medium gemini-3.8-flash-low ;;\nacp) shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, "fake-acp.mjs"))} "$@" ;;\nesac\n`,
    { mode: 0o700 },
  );
}
await writeFile(
  join(conf, "config.json"),
  JSON.stringify({ binary, sendSystemPrompt: false }),
);
let app;
try {
  app = await openApp(scriptedModel(), dataDir);
  async function status() {
    const entry = (await app.extensions(owner(app))).modules.find(
      (entry) => entry.file === file,
    );
    assert.ok(entry);
    assert.equal(entry.error, undefined);
    return entry;
  }
  const off = await status();
  assert.equal(off.enabled, false);
  console.log(
    `Extensions status before enabling the isolated copy: ${JSON.stringify({ file: off.file, enabled: off.enabled, status: off.status, error: off.error ?? null })}`,
  );
  await app.setExtensionEnabled(owner(app), guard, true);
  await app.setExtensionEnabled(owner(app), file, true);
  await until(
    async () => (await status()).enabled,
    "isolated extension enabled",
    10_000,
  );
  await until(
    () => Boolean(app.models.getModel("antigravity", id)),
    "Antigravity model registered",
    10_000,
  );
  console.log(
    "Isolated extension loaded without errors; Antigravity model in registry.",
  );
  const { id: conversation } = await app.commands.createSession(
    owner(app),
    { cwd: work, title: "Antigravity fixture check" },
    { model: { provider: "antigravity", modelId: id }, thinkingLevel: "low" },
  );
  await loadTools(app, conversation, "read");
  const { submissionId } = await app.commands.submit(conversation, owner(app), {
    text: "Use the Pi read tool once on fixture.txt (relative path). Report its exact contents. Do not call any other tools or read anything else.",
    requestId: crypto.randomUUID(),
  });
  const settled = await (
    await app.harness.submission(submissionId, context)
  ).wait(context);
  const { messages } = await (
    await app.harness.conversation(conversation, context)
  ).context(context);
  const reads = messages.filter(
    (m) => m.role === "toolResult" && m.toolName === "read",
  );
  const answer = messages.findLast((m) => m.role === "assistant");
  if (!reads.length || answer?.stopReason !== "stop")
    console.error("Safe failure diagnostics:", {
      outcome: settled.status,
      stops: messages
        .filter((m) => m.role === "assistant")
        .map(({ stopReason, errorMessage }) => ({ stopReason, errorMessage })),
      toolNames: messages
        .filter((m) => m.role === "toolResult")
        .map((m) => m.toolName),
      answerText: answer?.content
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("")
        .slice(0, 1200),
    });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].isError, false);
  assert.match(JSON.stringify(reads[0].content), new RegExp(fixture));
  assert.equal(answer.stopReason, "stop");
  assert.match(JSON.stringify(answer.content), new RegExp(fixture));
  console.log(
    `${live ? "Live Gemini Flash (low)" : "Mocked ACP"}: 1 Pi read tool result; final answer contains ${fixture}.`,
  );
} finally {
  await app?.close();
  cleanUp();
}
