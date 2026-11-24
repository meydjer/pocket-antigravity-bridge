/** Adds Antigravity CLI models to Pi Pocket and routes their workspace actions through Pi tools. */
import type { Host, Web } from "./_pocket.d.ts";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import {
  createBridge,
  type BridgeOptions,
} from "./antigravity-bridge/provider.ts";
import {
  discover,
  FALLBACK_MODELS,
  toPiModel,
  type AgyModelEntry,
} from "./antigravity-bridge/models.ts";

export const pocketApi = 2;
export default async function antigravityBridge(host: Host, web: Web) {
  const dir = join(host.dataDir, "antigravity-bridge");
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    cfg = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Cannot read antigravity-bridge/config.json (expected a JSON object).",
      );
  }
  if (
    cfg.binary !== undefined &&
    (typeof cfg.binary !== "string" ||
      (cfg.binary !== "agy" && !isAbsolute(cfg.binary)))
  )
    throw new Error("Antigravity binary must be 'agy' or an absolute path.");
  if (
    cfg.sendSystemPrompt !== undefined &&
    typeof cfg.sendSystemPrompt !== "boolean"
  )
    throw new Error("sendSystemPrompt must be a boolean.");
  const options: BridgeOptions = {
    bin: typeof cfg.binary === "string" ? cfg.binary : "agy",
    sendSystemPrompt: cfg.sendSystemPrompt !== false,
    stageDir: join(dir, "work"),
  };
  const models = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
  const bridge = createBridge(options, models);
  const lifecycle = new AbortController();
  let discovery: Promise<string> | undefined;
  let status = "Using the fallback model list.";
  let removeProvider: (() => void) | undefined;
  web.onDispose(() => {
    lifecycle.abort();
    bridge.dispose();
    removeProvider?.();
  });
  function register(entries: AgyModelEntry[]) {
    const unregister = host.registerModelProvider("antigravity", {
      api: "pocket-agy-acp",
      baseUrl: "pocket-agy-acp://antigravity",
      apiKey: "antigravity-local-cli",
      streamSimple: bridge.streamSimple,
      models: entries.map((m) => toPiModel(m, ["text", "image"])),
    });
    removeProvider?.();
    removeProvider = unregister;
    models.clear();
    for (const m of entries) models.set(m.id, m);
  }
  register(FALLBACK_MODELS);
  function refresh() {
    discovery ??= discover(options.bin, lifecycle.signal)
      .then((entries) => {
        if (lifecycle.signal.aborted) return status;
        if (!entries.length)
          return (status =
            "agy did not list models. Run `agy models` in the server account to check sign-in and PATH. The last model list is still in use.");
        register(entries);
        return (status = `agy lists ${entries.length} models: ${entries.map((e) => e.id).join(", ")}.`);
      })
      .catch(() => (status = "Could not refresh the Antigravity model list."))
      .finally(() => {
        discovery = undefined;
      });
    return discovery;
  }
  const scheduled = setTimeout(() => void refresh(), 50);
  scheduled.unref();
  web.onDispose(() => clearTimeout(scheduled));

  web.command("agy-status", {
    description:
      "Show Antigravity model status, or check sign-in and refresh the models",
    scope: "global",
    args: "[doctor]",
    handler: async (args) => {
      const action = args.trim();
      if (action && action !== "doctor")
        throw web.error(400, "Use /agy-status or /agy-status doctor.");
      return {
        type: "card",
        output: action === "doctor" ? await refresh() : status,
      };
    },
  });
  const ask = defineTool({
    name: "antigravity_ask",
    description:
      "Ask a text-only Antigravity model for a second opinion. It has no Pi tools or workspace access. Sends the supplied question to Google Antigravity.",
    parameters: obj({
      question: str({ minLength: 1, maxLength: 20_000 }),
      model: opt(
        str({
          description:
            "Optional antigravity model ID as shown in the model picker",
        }),
      ),
    }),
    execute: async (args, api, context) => {
      if (host.heldBack(api.conversationId) !== undefined)
        throw new Error("A spend limit holds this session back.");
      const target =
        args.model ?? [...models.keys()].find((id) => id.startsWith("gemini-"));
      const model = target && api.models.getModel("antigravity", target);
      if (!model)
        throw new Error("No such Antigravity model. Check /agy-status.");
      const reply = await api.models.completeSimple(
        model,
        {
          messages: [
            { role: "user", content: args.question, timestamp: Date.now() },
          ],
        },
        { telemetry: context.telemetry },
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted")
        throw new Error(reply.errorMessage ?? "Antigravity did not answer.");
      const answer = reply.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      return {
        output: [
          { type: "text", text: answer || "Antigravity returned no text." },
        ],
      };
    },
  });
  return defineExtension({ name: "antigravity-bridge", tools: [ask] });
}
