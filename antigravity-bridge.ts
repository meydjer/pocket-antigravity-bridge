/** Adds Antigravity CLI models to Pi Pocket and routes their workspace actions through Pi tools. */
import type { Host, Web } from "./_pocket.d.ts";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type { BridgeOptions } from "./antigravity-bridge/provider.ts";
import {
  discover,
  FALLBACK_MODELS,
  toPiModel,
  type AgyModelEntry,
} from "./antigravity-bridge/models.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;

async function imageBlock(path: string, remaining: number): Promise<[ImageContent, number]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const { size, isFile } = await file.stat().then((s) => ({ size: s.size, isFile: s.isFile() }));
    if (!isFile || size === 0 || size > Math.min(MAX_IMAGE_BYTES, remaining))
      throw new Error("Images must be nonempty regular files, at most 5 MiB each and 16 MiB total.");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (!bytesRead) throw new Error("An image changed while being read.");
      offset += bytesRead;
    }
    const prefix = bytes.subarray(0, 12);
    const mimeType = prefix.subarray(0, 3).toString("hex") === "ffd8ff" ? "image/jpeg"
      : prefix.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "image/png"
      : /^GIF8[79]a$/.test(prefix.toString("latin1", 0, 6)) ? "image/gif"
      : prefix.toString("latin1", 0, 4) === "RIFF" && prefix.toString("latin1", 8) === "WEBP" ? "image/webp"
      : undefined;
    if (!mimeType) throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
    return [{ type: "image", mimeType, data: bytes.toString("base64") }, size];
  } finally {
    await file.close();
  }
}

// Pi Pocket reloads the entry point but caches helpers. Give this revision of
// the provider a new import URL so the drop-in can update without a restart.
const { createBridge } = (await import(
  new URL("./antigravity-bridge/provider.ts?v=2026-11-24-images", import.meta.url).href
)) as typeof import("./antigravity-bridge/provider.ts");

// Pi Pocket's host supplies its normal file protection for paths in this tool's
// string array (core automatically looks for path fields, not array strings).
type ReadGuard = {
  guard: {
    judge(tool: "read", args: { path: string; source: string }, cwd: string):
      Promise<{ decision: { action: string } } | undefined>;
  };
};

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
      "Ask Antigravity for a second opinion. Sends the question and any attached images to Google Antigravity. The model has no Pi tools or workspace access.",
    parameters: obj({
      question: str({ minLength: 1, maxLength: 20_000 }),
      images: opt(arr(str({ minLength: 1 }), {
        maxItems: 8,
        description: "Absolute local paths of images to attach (up to 8).",
      })),
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
      const images: ImageContent[] = [];
      if (args.images?.length) {
        const guard = (host as Host & Partial<ReadGuard>).guard;
        if (!guard) throw new Error("Local image attachments need Pi Pocket file protection.");
        let remaining = TOTAL_IMAGE_BYTES;
        for (const path of args.images) {
          if (!isAbsolute(path)) throw new Error("Image paths must be absolute.");
          const source = await realpath(path);
          const judgment = await guard.judge("read", { path, source }, "/");
          if (judgment && judgment.decision.action !== "allow")
            throw new Error("Pi Pocket does not allow reading one of the attached images.");
          const [image, size] = await imageBlock(source, remaining);
          images.push(image);
          remaining -= size;
        }
      }
      const reply = await api.models.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: images.length ? [{ type: "text", text: args.question }, ...images] : args.question,
              timestamp: Date.now(),
            },
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
