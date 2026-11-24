// Opt-in live test. The default uses a mock and no account or quota.
import assert from "node:assert/strict";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
const fixturePath = join(work, "fixture.txt");
const mockCatalog = join(root, "agy-models");
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
const imagePath = join(work, "fixture.png");
const outsideDir = `${work}-outside`;
const outsideImage = join(outsideDir, "fixture.png");
const linkedImage = join(work, "linked.png");
const attachments = new Map([
  ["relative", ["fixture.txt"]],
  ["too many", Array(9).fill(imagePath)],
  ["not an image", [fixturePath]],
  ["outside", [outsideImage]],
  ["symlink outside", [linkedImage]],
  ["workspace image", [imagePath]],
]);
await mkdir(dropIns, { recursive: true });
await cp(join(import.meta.dirname, "..", file), join(dropIns, file));
await cp(
  join(import.meta.dirname, "../antigravity-bridge"),
  join(dropIns, "antigravity-bridge"),
  { recursive: true },
);
await writeFile(fixturePath, fixture + "\n");
const guard = "fixture-guard.ts";
await writeFile(
  join(dropIns, guard),
  `
    import { defineExtension, hook, ToolTask, GenerationTask } from "@earendil-works/pi-durable";
    export default () => defineExtension({ name: "fixture-guard", hooks: [
        hook(ToolTask, { beforeTool: (call) => (call.name === "read" && call.arguments.path === "fixture.txt")
            || (${!live} && call.name === "antigravity_ask")
            ? undefined : { block: "Tool not permitted in this test." } }),
        hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: messages.map((m) =>
            m.role === "system" && m.toolsAdded ? { ...m, toolsAdded: m.toolsAdded.filter((t) =>
                t.name === "read" || (${!live} && t.name === "antigravity_ask")) } : m) }) }),
    ] });
`,
);
const conf = join(dataDir, "antigravity-bridge");
await mkdir(conf);
let binary = process.env.AGY_BINARY ?? "agy";
if (!live) {
  process.env.HOME = join(root, "home");
  binary = join(root, "fake-agy");
  await writeFile(mockCatalog, "gemini-3.8-flash-medium\ngemini-3.8-flash-low\n");
  await mkdir(outsideDir);
  for (const path of [imagePath, outsideImage]) await writeFile(path, Buffer.from(imageData, "base64"));
  await symlink(outsideImage, linkedImage);
  await writeFile(
    binary,
    `#!/bin/sh\ncase "$1" in\nmodels) cat ${JSON.stringify(mockCatalog)} ;;\n--version) echo 1.5.17 ;;\nacp) shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, "fake-acp.mjs"))} "$@" ;;\nesac\n`,
    { mode: 0o700 },
  );
}
await writeFile(
  join(conf, "config.json"),
  JSON.stringify({ binary, sendSystemPrompt: false }),
);
let app;
try {
  app = await openApp(scriptedModel(({ messages }) => {
    const last = messages.at(-1);
    const message = last?.role === "user" && (typeof last.content === "string"
      ? last.content
      : last.content.find((block) => block.type === "text")?.text);
    const images = !live && attachments.get(message);
    return images
      ? fauxAssistantMessage([fauxToolCall("antigravity_ask", { question: "inline-ask-test", images })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("Done")]);
  }), dataDir);
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
  if (!live) {
    const wrongFolder = /Images must be inside this session/i;
    for (const [label, guidance] of [
      ["relative", /Image paths must be absolute/i],
      ["too many", /images[^\n]*8|at most 8/i],
      ["not an image", /Use a JPEG, PNG, GIF, or WebP image/i],
      ["outside", wrongFolder],
      ["symlink outside", wrongFolder],
      ["another session upload", wrongFolder],
      ["workspace image"],
      ["session upload"],
    ]) {
      const { id: askSession } = await app.commands.createSession(owner(app), { cwd: work },
        { model: { provider: "faux", modelId: "faux-vision" }, thinkingLevel: "off" });
      if (label.endsWith("upload")) {
        const uploadDir = join(dataDir, "uploads", String(label === "session upload" ? askSession : conversation));
        const upload = join(uploadDir, "fixture.png");
        await mkdir(uploadDir, { recursive: true });
        await writeFile(upload, Buffer.from(imageData, "base64"));
        attachments.set(label, [upload]);
      }
      await loadTools(app, askSession, "antigravity_ask");
      const { submissionId } = await app.commands.submit(askSession, owner(app), {
        text: label, requestId: crypto.randomUUID(),
      });
      await (await app.harness.submission(submissionId, context)).wait(context);
      const { messages } = await (await app.harness.conversation(askSession, context)).context(context);
      const result = messages.find((m) => m.role === "toolResult" && m.toolName === "antigravity_ask");
      assert.ok(result, `No antigravity_ask result for ${label}`);
      assert.equal(result.isError, Boolean(guidance), JSON.stringify(result.content));
      if (guidance) assert.match(JSON.stringify(result.content), guidance);
      else assert.deepEqual(result.content, [{ type: "text", text: `ask image: ${imageData}` }]);
    }
    console.log("antigravity_ask accepts workspace images and session uploads; it rejects invalid or external files.");

    const commandId = () => app.webs.commands().find((command) => command.name === "agy-status")?.id;
    const doctor = () => app.extensionCommands.run(conversation, owner(app), {
      commandId: commandId(), args: "doctor", requestId: crypto.randomUUID(),
    });
    assert.match((await doctor()).output, /agy --version: 1\.5\.17\. Warning: tested with 1\.5\.16\./);
    const refreshedId = "gemini-4-mock";
    await writeFile(mockCatalog, `${refreshedId}-low\n${refreshedId}-xhigh\n`);
    await app.models.refresh({ allowNetwork: false, providers: ["antigravity"] });
    assert.ok(app.models.getModel("antigravity", id));
    assert.equal(app.models.getModel("antigravity", refreshedId), undefined);
    await app.providers.modelRefresh.refresh();
    assert.equal(app.models.getModel("antigravity", id), undefined);
    assert.equal(app.models.getModel("antigravity", `${refreshedId}-xhigh`), undefined);
    assert.equal(app.models.getModel("antigravity", refreshedId)?.thinkingLevelMap?.xhigh, "xhigh");
    console.log("Refresh models replaces the catalog only on a network pass.");

  }
} finally {
  await app?.close();
  cleanUp();
}
