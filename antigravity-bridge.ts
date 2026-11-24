/** Adds Antigravity models through the local `agy` CLI. When enabled or refreshed, the CLI contacts Google Antigravity to list models. During turns, it sends prompts, transcript context, tool results, and images to Google Antigravity. The bridge serves an MCP endpoint on 127.0.0.1 with a per-connection token and routes workspace actions through Pi tools. It reads its optional config and writes temporary ACP agent config and workspaces only under `antigravity-bridge/` in the Pi Pocket data folder. The CLI uses and manages its own sign-in and app data under `~/.gemini/antigravity-cli`; the bridge does not read sign-in files. `antigravity_ask` reads selected images only from the current session's local working folder (using the experimental `host.cwdOf` API) or its own Pi Pocket uploads folder. */
import type { Host, Web } from "./_pocket.d.ts";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { createBridge, type BridgeOptions } from "./antigravity-bridge/provider.ts";
import { discover, FALLBACK_MODELS, toPiModel, versionStatus } from "./antigravity-bridge/models.ts";

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

const realPath = (path: string) => realpath(path).catch(() => undefined);
function inside(root: string, path: string) {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

async function imageSource(host: Host, session: Parameters<Host["cwdOf"]>[0], path: string) {
  if (!isAbsolute(path)) throw new Error("Image paths must be absolute.");
  const cwd = host.cwdOf(session);
  const [source, work, data] = await Promise.all([
    realPath(path),
    isAbsolute(cwd) ? realPath(cwd) : undefined,
    realPath(host.dataDir),
  ]);
  if (!source) throw new Error("Could not find the image file.");
  if (data) {
    const uploads = join(data, "uploads");
    const ownUploads = join(uploads, String(session));
    if (inside(uploads, source) && inside(ownUploads, source) && await realPath(ownUploads) === ownUploads)
      return source;
    // A broad working directory must not grant access to other sessions' uploads.
    if (inside(uploads, source))
      throw new Error("Images must be inside this session's working folder or uploads folder.");
  }
  if (work && inside(work, source)) return source;
  throw new Error("Images must be inside this session's working folder or uploads folder.");
}

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
  const currentModels = () => [...models.values()].map((m) => toPiModel(m, ["text", "image"]));
  async function updateCatalog(signal: AbortSignal) {
    const entries = await discover(options.bin, signal);
    if (signal.aborted) return false;
    if (!entries.length) {
      status = "agy did not list models. Run `agy models` in the server account to check sign-in and PATH. The last model list is still in use.";
      return false;
    }
    models.clear();
    for (const m of entries) models.set(m.id, m);
    status = `agy lists ${entries.length} models: ${entries.map((e) => e.id).join(", ")}.`;
    return true;
  }
  function register() {
    const unregister = host.registerModelProvider("antigravity", {
      api: "pocket-agy-acp",
      baseUrl: "pocket-agy-acp://antigravity",
      apiKey: "antigravity-local-cli",
      streamSimple: bridge.streamSimple,
      models: currentModels(),
      async refreshModels({ allowNetwork, signal }) {
        if (allowNetwork) await updateCatalog(AbortSignal.any([signal, lifecycle.signal]));
        return currentModels();
      },
    });
    removeProvider?.();
    removeProvider = unregister;
  }
  register();
  function refresh() {
    // Startup and doctor are outside the runtime refresh callback, so register
    // again to publish their result through the host's local refresh.
    discovery ??= updateCatalog(lifecycle.signal)
      .then((changed) => {
        if (changed && !lifecycle.signal.aborted) register();
        return status;
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
      const output = action === "doctor"
        ? (await Promise.all([refresh(), versionStatus(options.bin, lifecycle.signal)])).join("\n")
        : status;
      return { type: "card", output };
    },
  });
  const ask = defineTool({
    name: "antigravity_ask",
    description:
      "Start the local agy CLI to ask Antigravity for a second opinion. Sends the question and selected session images to Google Antigravity. The model has no Pi tools or workspace access.",
    parameters: obj({
      question: str({ minLength: 1, maxLength: 20_000 }),
      images: opt(arr(str({ minLength: 1 }), {
        maxItems: 8,
        description: "Up to 8 absolute image paths inside this session's working folder or uploads folder.",
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
        let remaining = TOTAL_IMAGE_BYTES;
        for (const path of args.images) {
          const source = await imageSource(host, api.conversationId, path);
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
