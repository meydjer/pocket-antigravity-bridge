import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { JsonRpcSession, JsonRpcResponseError } from "./jsonrpc.ts";
import { dict, HEADER, SERVER, trace, type openMcp } from "./mcp.ts";

const AGENT = "pocket-pi-bridge";
type Spec = Awaited<ReturnType<typeof openMcp>>["spec"];
const gate = fileURLToPath(new URL("./native-gate.cjs", import.meta.url));
const shellQuote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";

export function safeError(error: unknown) {
  if (error instanceof JsonRpcResponseError && error.code === -32000) {
    return "Antigravity needs Google sign-in or could not connect. Run `agy models` in the server account, then retry.";
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
  await mkdir(opts.stageDir, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(opts.stageDir, "acp-"));
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
    if (proc) {
      killTimer = setTimeout(() => {
        try {
          proc?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000);
      killTimer.unref();
    }
    void rm(home, { recursive: true, force: true }).catch(() => {});
  }
  try {
    await chmod(home, 0o700);
    const cwd = join(home, "workspace");
    const agentDir = join(home, "config", "agents", AGENT);
    const appData = join(
      opts.geminiDir ?? join(homedir(), ".gemini"),
      "antigravity-cli",
    );
    // Only agy's own application data is shared for sign-in. Do not copy global agents, hooks, or MCP config.
    await mkdir(appData, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await symlink(appData, join(home, "antigravity-cli"), "dir");
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
                  command: `${shellQuote(process.execPath)} ${shellQuote(gate)}`,
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
        "tools: []",
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
        const allowed = promptActive && p.sessionId === sessionId && privateMcp;
        trace(`ACP permission request: ${allowed ? "private MCP" : "denied"}`);
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
    child.on("close", () => {
      close();
      clearTimeout(killTimer);
    });
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
