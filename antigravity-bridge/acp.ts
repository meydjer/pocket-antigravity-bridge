import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { JsonRpcSession, JsonRpcResponseError } from "./jsonrpc.ts";
import { dict, HEADER, SERVER, trace, type openMcp } from "./mcp.ts";

const AGENT = "pocket-pi-bridge";
type Spec = Awaited<ReturnType<typeof openMcp>>["spec"];
const gate = fileURLToPath(new URL("./native-gate.cjs", import.meta.url));
const shellQuote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";

const { allowMedia, markDenial } = createRequire(import.meta.url)(gate) as {
  allowMedia: (args: unknown, appData: string, stagedAppData: string) => boolean;
  markDenial: (path: string) => void;
};
const activeHomes = new Set<string>();
const DAY_MS = 24 * 60 * 60_000;

export async function removeStaleAcpHomes(stageDir: string) {
  const root = resolve(stageDir);
  try {
    if (!(await lstat(root)).isDirectory()) return;
    const cutoff = Date.now() - DAY_MS;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^acp-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      if (activeHomes.has(path)) continue;
      try {
        const info = await lstat(path);
        if (info.isDirectory() && info.mtimeMs < cutoff)
          await rm(path, { recursive: true, force: true });
      } catch {
        trace("Could not remove a stale ACP work folder");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      trace("Could not check for stale ACP work folders");
  }
}

export function safeError(error: unknown) {
  if (error instanceof JsonRpcResponseError) {
    const detail = `${error.message} ${JSON.stringify(error.data) ?? ""}`;
    if (error.code === -32000 && /authentication required/i.test(detail))
      return "Antigravity needs sign-in. Run `agy` in a terminal on the server to sign in, then retry.";
    if (error.code === 429 || /\b(quota|rate[ _-]?limit|too many requests|resource[ _-]exhausted)\b/i.test(detail))
      return "Antigravity reached a quota or rate limit. Wait and retry, or select another provider.";
  }
  // Never show raw CLI errors, stderr, MCP credentials or ACP payloads.
  return "Antigravity ACP could not complete this request. Check `/agy-status doctor` and the installed agy version.";
}

export async function openAcp(opts: {
  bin: string;
  binArgs?: string[];
  geminiDir?: string;
  stageDir: string;
  mcp: Spec;
  instructions: string;
  onUpdate: (update: Record<string, unknown>) => void;
  signal: AbortSignal;
}) {
  const stageDir = resolve(opts.stageDir);
  await mkdir(stageDir, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(stageDir, "acp-"));
  activeHomes.add(home);
  const denial = join(home, "media-denied");
  let cleaning = false;
  function removeHome() {
    if (cleaning) return;
    cleaning = true;
    void rm(home, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => trace("Could not remove the ACP work folder"))
      .finally(() => activeHomes.delete(home));
  }
  let proc: ChildProcessWithoutNullStreams | undefined;
  let rpc: JsonRpcSession | undefined;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;
  let sessionId: string | undefined;
  let promptActive = false;
  function close() {
    if (closed) return;
    closed = true;
    rpc?.abortAll("ACP closed");
    proc?.stdin.end();
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      killTimer = setTimeout(() => {
        try {
          proc?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000);
      killTimer.unref();
    } else {
      removeHome();
    }
  }
  try {
    await chmod(home, 0o700);
    const cwd = join(home, "workspace");
    const agentDir = join(home, "config", "agents", AGENT);
    const appData = resolve(opts.geminiDir ?? join(homedir(), ".gemini"), "antigravity-cli");
    const stagedAppData = join(home, "antigravity-cli");
    // Only agy's own application data is shared for sign-in. Do not copy global agents, hooks, or MCP config.
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await symlink(appData, stagedAppData, "dir");
    await writeFile(
      join(home, "config", "mcp_config.json"),
      '{"mcpServers":{}}',
      { mode: 0o600 },
    );
    await writeFile(
      join(agentDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: [process.execPath, gate, appData, stagedAppData, denial].map(shellQuote).join(" "),
                  timeout: 3,
                },
              ],
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(agentDir, "agent.md"),
      [
        "---",
        `name: ${AGENT}`,
        'description: "Pi Pocket restricted ACP agent"',
        "mainAgent: true",
        "model: inherit",
        "subagent: false",
        "excludeDefaultComponents: true",
        "inheritCustomizations: false",
        "inheritMcp: true",
        "tools: [view_file]",
        "skills: []",
        "rules: []",
        "agents: []",
        "hooks:",
        '  - "hooks.json"',
        "plugins: []",
        "mcpServers:",
        `  - name: ${JSON.stringify(SERVER)}`,
        `    serverUrl: ${JSON.stringify(opts.mcp.url)}`,
        "    headers:",
        `      ${HEADER}: ${JSON.stringify(opts.mcp.headers[0]?.value)}`,
        "---",
        "",
        opts.instructions,
      ].join("\n"),
      { mode: 0o600 },
    );
    opts.signal.throwIfAborted();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(HOME|PATH|USER|LOGNAME|LANG|LC_\w+|TZ|TMPDIR|XDG_(CONFIG|DATA|CACHE|RUNTIME)_HOME|XDG_RUNTIME_DIR|MISE_\w+|SSL_CERT_(FILE|DIR)|DBUS_SESSION_BUS_ADDRESS)$/.test(
          key,
        ),
      ),
    );
    proc = spawn(
      opts.bin,
      [
        ...(opts.binArgs ?? ["acp"]),
        "--agent",
        AGENT,
        "--include-default-customizations=false",
        "--gemini-dir",
        home,
      ],
      { cwd, env, stdio: "pipe" },
    );
    const child = proc;
    const transport = new JsonRpcSession({
      send: (frame) => {
        if (!closed && child.stdin.writable) child.stdin.write(frame + "\n");
      },
      onOverflow: close,
      onNotification: (method, params) => {
        const data = dict(params);
        if (
          promptActive &&
          method === "session/update" &&
          data.sessionId === sessionId
        ) {
          const update = dict(data.update);
          if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          )
            trace(`ACP ${update.sessionUpdate}`);
          opts.onUpdate(update);
        }
      },
      onRequest: async (method, params) => {
        if (method !== "session/request_permission")
          throw new Error("Pi ACP capability disabled");
        const p = dict(params);
        const call = dict(p.toolCall);
        const name = call.name;
        const input = dict(call.rawInput);
        const meta = dict(dict(call._meta).mcp);
        const privateMcp =
          (typeof name === "string" && name.startsWith(`mcp_${SERVER}_`)) ||
          (name === "call_mcp_tool" && input.ServerName === SERVER) ||
          meta.server === SERVER;
        const active = promptActive && p.sessionId === sessionId;
        const media = name === "view_file" && allowMedia(call.rawInput, appData, stagedAppData);
        if (active && name === "view_file" && !media) markDenial(denial);
        // PreToolUse enforces the hook conversation ID, if agy supplies it.
        const allowed = active && (name === "view_file" ? media : privateMcp);
        trace(allowed ? "ACP permission request: allowed" : "ACP permission request: denied");
        const options = Array.isArray(p.options) ? p.options.map(dict) : [];
        const selected = options.find(
          (o) =>
            typeof o.optionId === "string" &&
            o.kind === (allowed ? "allow_once" : "reject_once"),
        );
        return {
          outcome: selected
            ? { outcome: "selected", optionId: selected.optionId }
            : { outcome: "cancelled" },
        };
      },
    });
    rpc = transport;
    child.stdin.on("error", close);
    child.stdout.on("error", close);
    child.stderr.resume();
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => transport.feed(chunk));
    child.on("error", close);
    // Wait for agy to stop so that it cannot recreate its work folder.
    const reap = () => {
      close();
      clearTimeout(killTimer);
      removeHome();
    };
    child.once("exit", reap);
    child.once("close", reap);
    const cancelStart = () => close();
    opts.signal.addEventListener("abort", cancelStart, { once: true });
    try {
      const init = dict(
        await transport.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          25_000,
        ),
      );
      if (init.protocolVersion !== 1)
        throw new Error("ACP protocol version not supported");
      const created = dict(
        await transport.request(
          "session/new",
          { cwd, mcpServers: [opts.mcp] },
          30_000,
        ),
      );
      if (typeof created.sessionId !== "string" || !created.sessionId)
        throw new Error("ACP returned no session ID");
      sessionId = created.sessionId;
    } finally {
      opts.signal.removeEventListener("abort", cancelStart);
    }
    return {
      close,
      get alive() {
        return !closed;
      },
      resetMediaDenial() {
        rmSync(denial, { force: true });
      },
      mediaDenied() {
        return existsSync(denial);
      },
      async prompt(blocks: object[], model: string, effort?: string) {
        await transport.request(
          "session/set_config_option",
          { sessionId, configId: "model", value: model },
          20_000,
        );
        if (effort)
          await transport.request(
            "session/set_config_option",
            { sessionId, configId: "thought_level", value: effort },
            20_000,
          );
        promptActive = true;
        try {
          return dict(
            await transport.request("session/prompt", {
              sessionId,
              prompt: blocks,
            }),
          );
        } finally {
          promptActive = false;
        }
      },
      cancel() {
        if (sessionId && promptActive)
          transport.notify("session/cancel", { sessionId });
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
