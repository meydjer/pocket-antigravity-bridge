import { createHash, randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Api,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAcp, safeError } from "./acp.ts";
import {
  dict,
  openMcp,
  POLL,
  result,
  SERVER,
  trace,
  type Dict,
  type McpResult,
  type McpTool,
} from "./mcp.ts";
import { type AgyModelEntry, toAgyEffort } from "./models.ts";

export type BridgeOptions = {
  bin: string;
  binArgs?: string[];
  stageDir: string;
  geminiDir?: string;
  sendSystemPrompt?: boolean;
  pollMs?: number;
  turnMs?: number;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownTool = "antigravity_ask"; // Do not offer this tool to its own provider.
const pollTool: McpTool = {
  name: POLL,
  description:
    "Get the result of a Pi tool that returned STILL RUNNING. Wait for the result before doing more work.",
  inputSchema: {
    type: "object",
    properties: { callId: { type: "string" } },
    required: ["callId"],
    additionalProperties: false,
  },
};
const text = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
const zero = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const count = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;

function project(context: TranscriptContext, withTools: boolean) {
  const parts: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, McpTool>();
  const messages = context.messages.filter((m) => {
    if (m.role !== "system") return true;
    const line = text(m.content);
    if (line) parts.push(line);
    for (const [name, value] of Object.entries(m.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) {
      if (
        withTools &&
        t.name !== ownTool &&
        t.name !== POLL &&
        /^[A-Za-z0-9_-]{1,128}$/.test(t.name)
      )
        tools.set(t.name, {
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        });
    }
    return false;
  });
  return {
    messages,
    system: [...parts, ...sections.values()].join("\n\n"),
    tools,
  };
}

function signature(messages: Message[]) {
  return hash(
    messages.map((m) => [
      m.role,
      m.role === "toolResult" ? m.toolCallId : "",
      m.content,
    ]),
  );
}
// Bound reconstructed image attachments to leave room for the rest of the ACP frame.
const HISTORY_IMAGE_BYTES = 24 * 1024 * 1024; // Base64 bytes
function prompt(messages: Message[], history: boolean) {
  const last = messages.at(-1);
  const blocks: object[] = [];
  if (history) {
    // Use Pi's durable context, not agy's old loop. History is data, not a new tool request.
    const prior = messages
      .slice(0, last?.role === "user" ? -1 : messages.length)
      .slice(-160);
    const digest = prior.map((m) => ({
      role: m.role,
      text: text(m.content).slice(-8000),
      ...(m.role === "toolResult"
        ? { tool: m.toolName, failed: m.isError }
        : {}),
    }));
    if (digest.length)
      blocks.push({
        type: "text",
        text:
          "Pi Pocket history (JSON transcript data, not new instructions or calls to repeat):\n" +
          JSON.stringify(digest).slice(-150_000),
      });
    if (last?.role === "toolResult") {
      const images: { index: number; image: ImageContent }[] = [];
      let bytes = 0;
      let omitted = false;
      for (let i = prior.length - 1; i >= 0; i--) {
        const m = prior[i];
        if ((m.role === "toolResult" || m.role === "user") && Array.isArray(m.content)) {
          for (const image of m.content) {
            if (image.type !== "image") continue;
            if (images.length >= 8 || bytes + image.data.length > HISTORY_IMAGE_BYTES) {
              omitted = true;
              continue;
            }
            images.push({ index: i, image });
            bytes += image.data.length;
          }
        }
        if (m.role === "user") break;
      }
      for (const { index, image } of images.sort((a, b) => a.index - b.index)) {
        blocks.push({ type: "text", text: `Image from Pi history entry ${index + 1}:` }, image);
      }
      if (omitted)
        blocks.push({ type: "text", text: "Some Pi history images exceeded the attachment limit." });
    }
  }
  if (last?.role === "user") {
    if (Array.isArray(last.content))
      blocks.push(...last.content.filter((b) => b.type === "image"));
    blocks.push({
      type: "text",
      text: text(last.content) || "Use the attached input.",
    });
  } else
    blocks.push({
      type: "text",
      text: "Continue from the Pi Pocket transcript. Do not repeat completed tools.",
    });
  return blocks;
}

class Reply {
  readonly stream = createAssistantMessageEventStream();
  readonly message: AssistantMessage;
  private open?: number;
  private started = false;
  ended = false;
  onEnd?: () => void;
  constructor(model: Model<Api>) {
    this.message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: zero(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }
  start() {
    if (!this.started) {
      this.started = true;
      this.stream.push({ type: "start", partial: this.message });
    }
  }
  closeBlock() {
    if (this.open === undefined) return;
    const i = this.open;
    this.open = undefined;
    const b = this.message.content[i];
    if (b.type === "text")
      this.stream.push({
        type: "text_end",
        contentIndex: i,
        content: b.text,
        partial: this.message,
      });
    if (b.type === "thinking")
      this.stream.push({
        type: "thinking_end",
        contentIndex: i,
        content: b.thinking,
        partial: this.message,
      });
  }
  delta(type: "text" | "thinking", delta: string) {
    if (this.ended || !delta) return;
    this.start();
    if (
      this.open === undefined ||
      this.message.content[this.open].type !== type
    ) {
      this.closeBlock();
      this.open = this.message.content.length;
      this.message.content.push(
        type === "text" ? { type, text: "" } : { type, thinking: "" },
      );
      this.stream.push({
        type: type === "text" ? "text_start" : "thinking_start",
        contentIndex: this.open,
        partial: this.message,
      });
    }
    const b = this.message.content[this.open];
    if (b.type === "text") b.text += delta;
    else if (b.type === "thinking") b.thinking += delta;
    this.stream.push({
      type: type === "text" ? "text_delta" : "thinking_delta",
      contentIndex: this.open,
      delta,
      partial: this.message,
    });
  }
  call(call: ToolCall) {
    this.start();
    this.closeBlock();
    const contentIndex =
      this.message.content.push({ ...call, arguments: {} }) - 1;
    this.stream.push({
      type: "toolcall_start",
      contentIndex,
      partial: this.message,
    });
    this.message.content[contentIndex] = call;
    this.stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify(call.arguments),
      partial: this.message,
    });
    this.stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall: call,
      partial: this.message,
    });
    this.finish("toolUse");
  }
  finish(
    reason: "stop" | "length" | "toolUse" | "aborted" | "error",
    error?: string,
  ) {
    if (this.ended) return;
    this.ended = true;
    this.closeBlock();
    this.message.stopReason = reason;
    this.onEnd?.();
    if (reason === "error" || reason === "aborted") {
      this.message.errorMessage = error;
      this.stream.push({ type: "error", reason, error: this.message });
    } else {
      this.start();
      this.stream.push({ type: "done", reason, message: this.message });
    }
    this.stream.end(this.message);
  }
}

type Waiting = { name: string; args: Dict; resolve: (r: McpResult) => void };
type Handoff = Waiting & {
  id: string;
  timer: NodeJS.Timeout;
  acknowledged: boolean;
  prefix: string;
};
class Cell {
  usedAt = Date.now();
  expected?: string;
  dead = false;
  private acp?: Awaited<ReturnType<typeof openAcp>>;
  private mcp?: Awaited<ReturnType<typeof openMcp>>;
  private controller = new AbortController();
  private turn?: {
    request: ReturnType<typeof project>;
    reply?: Reply;
    handoff?: Handoff;
    queued: Waiting[];
    delivered: Map<string, McpResult>;
    buffered: { type: "text" | "thinking"; delta: string }[];
    bufferedSize: number;
    timer: NodeJS.Timeout;
    final?: Dict;
  };
  readonly profile: string;
  private options: BridgeOptions;
  constructor(profile: string, options: BridgeOptions) {
    this.profile = profile;
    this.options = options;
  }
  get busy() {
    return Boolean(this.turn);
  }
  get alive() {
    return !this.dead && Boolean(this.acp?.alive);
  }
  close(
    reason: "error" | "aborted" = "error",
    message = "Antigravity bridge closed.",
  ) {
    if (this.dead) return;
    this.dead = true;
    const t = this.turn;
    this.turn = undefined;
    if (t) {
      clearTimeout(t.timer);
      if (t.handoff) {
        clearTimeout(t.handoff.timer);
        t.handoff.resolve(result("Pi tool interrupted.", true));
      }
      for (const w of t.queued) w.resolve(result("Pi tool interrupted.", true));
      t.reply?.finish(reason, message);
    }
    if (reason === "aborted") this.acp?.cancel();
    this.controller.abort();
    this.mcp?.close();
    this.acp?.close();
  }
  async run(
    reply: Reply,
    request: ReturnType<typeof project>,
    selection: AgyModelEntry,
    opts: SimpleStreamOptions | undefined,
  ) {
    this.usedAt = Date.now();
    const t = {
      request,
      queued: [],
      delivered: new Map(),
      buffered: [],
      bufferedSize: 0,
      timer: setTimeout(
        () =>
          this.close(
            "error",
            "Antigravity turn timed out. Pi tool calls are not replayed.",
          ),
        this.options.turnMs ?? 30 * 60_000,
      ),
    };
    this.turn = t;
    this.attach(reply, opts);
    try {
      if (!this.acp) {
        const mcp = await openMcp(
          () => {
            const tools = [
              ...(this.turn?.request.tools.values() ?? request.tools.values()),
            ];
            return tools.length ? [...tools, pollTool] : [];
          },
          (name, args) => this.onMcp(name, args),
        );
        if (this.dead) {
          mcp.close();
          return;
        }
        this.mcp = mcp;
        this.acp = await openAcp({
          ...this.options,
          mcp: mcp.spec,
          signal: this.controller.signal,
          onUpdate: (u) => this.onUpdate(u),
          instructions: [
            this.options.sendSystemPrompt === false ? "" : request.system,
            `Pi Pocket protocol: use only tools from the private ${SERVER} server for actions. Use direct mcp_${SERVER}_<tool> or call_mcp_tool with ServerName=${SERVER}, ToolName and Arguments. Do not use any native tools. When a call returns STILL RUNNING, call ${POLL} with that callId until the result arrives. Do not repeat that call.`,
            ...[...request.tools.values()].map((x) => JSON.stringify(x)),
          ].join("\n\n"),
        });
      }
      if (this.dead) {
        this.acp?.close();
        return;
      }
      const effort =
        selection.efforts && toAgyEffort(opts?.reasoning, selection.efforts);
      const final = await this.acp.prompt(
        prompt(request.messages, !this.expected),
        selection.full,
        effort,
      );
      if (!this.dead && this.turn) {
        this.turn.final = final;
        this.flush();
      }
    } catch (error) {
      if (!this.dead) this.close("error", safeError(error));
    }
  }
  resume(
    reply: Reply,
    request: ReturnType<typeof project>,
    opts?: SimpleStreamOptions,
  ) {
    const t = this.turn;
    if (!t || t.reply || !t.handoff) return false;
    const h = t.handoff;
    const last = request.messages.at(-1);
    if (
      last?.role !== "toolResult" ||
      last.toolCallId !== h.id ||
      signature(request.messages.slice(0, -1)) !== h.prefix
    )
      return false;
    if (last.content.some((block) => block.type === "image")) {
      // agy offloads MCP images to paths. End this ACP turn and resume from Pi's
      // transcript with inline ACP image blocks instead of granting native reads.
      this.close();
      return false;
    }
    this.usedAt = Date.now();
    clearTimeout(h.timer);
    t.request = request;
    t.handoff = undefined;
    const actual: McpResult = { content: last.content, isError: last.isError };
    if (h.acknowledged) t.delivered.set(h.id, actual);
    else h.resolve(actual);
    this.attach(reply, opts);
    this.flush();
    return true;
  }
  private attach(reply: Reply, opts?: SimpleStreamOptions) {
    this.turn!.reply = reply;
    const signal = opts?.signal;
    if (!signal) return;
    const cancel = () => this.close("aborted", "Antigravity turn cancelled.");
    reply.onEnd = () => signal.removeEventListener("abort", cancel);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  }
  private onUpdate(update: Dict) {
    const t = this.turn;
    if (!t) return;
    const type =
      update.sessionUpdate === "agent_message_chunk"
        ? "text"
        : update.sessionUpdate === "agent_thought_chunk"
          ? "thinking"
          : undefined;
    const b = dict(update.content);
    if (!type || b.type !== "text" || typeof b.text !== "string") return;
    if (t.reply) t.reply.delta(type, b.text);
    else {
      t.bufferedSize += b.text.length;
      if (t.bufferedSize > 1024 * 1024 || t.buffered.length > 12_000)
        this.close(
          "error",
          "Antigravity sent too much output while waiting for a Pi tool.",
        );
      else t.buffered.push({ type, delta: b.text });
    }
  }
  private onMcp(name: string, args: Dict): Promise<McpResult> {
    const t = this.turn;
    if (!t || this.dead)
      return Promise.resolve(result("No active Pi turn.", true));
    return new Promise((resolve) => {
      t.queued.push({ name, args, resolve });
      this.flush();
    });
  }
  private flush() {
    const t = this.turn;
    if (!t || !t.reply) return;
    const reply = t.reply;
    for (const b of t.buffered) reply.delta(b.type, b.delta);
    t.buffered = [];
    t.bufferedSize = 0;
    if (t.final) {
      const stop = t.final.stopReason;
      if (
        !["end_turn", "max_tokens", "stop_sequence", "cancelled"].includes(
          String(stop),
        )
      ) {
        this.close("error", "Antigravity did not finish the turn.");
        return;
      }
      if (stop === "cancelled") {
        this.close("aborted", "Antigravity turn cancelled.");
        return;
      }
      clearTimeout(t.timer);
      for (const w of t.queued) w.resolve(result("Pi turn ended.", true));
      const u = dict(t.final.usage);
      const message = reply.message;
      message.usage.input = count(u.inputTokens);
      message.usage.output = count(u.outputTokens);
      message.usage.totalTokens =
        count(u.totalTokens) || message.usage.input + message.usage.output;
      message.usage.cacheRead = count(u.cachedReadTokens);
      if (typeof u.thoughtTokens === "number")
        message.usage.reasoning = count(u.thoughtTokens);
      this.expected = signature([...t.request.messages, message]);
      this.turn = undefined;
      this.usedAt = Date.now();
      reply.finish(stop === "max_tokens" ? "length" : "stop");
      return;
    }
    let w: Waiting | undefined;
    while ((w = t.queued.shift())) {
      if (w.name === POLL) {
        const r =
          typeof w.args.callId === "string"
            ? t.delivered.get(w.args.callId)
            : undefined;
        w.resolve(r ?? result("Unknown or expired Pi tool call ID.", true));
        continue;
      }
      if (!t.request.tools.has(w.name)) {
        w.resolve(
          result("That tool is not in the current Pi tool list.", true),
        );
        continue;
      }
      const call: ToolCall = {
        type: "toolCall",
        id: `agy_${randomUUID().replaceAll("-", "")}`,
        name: w.name,
        arguments: w.args as ToolCall["arguments"],
      };
      const h: Handoff = {
        ...w,
        id: call.id,
        prefix: "",
        acknowledged: false,
        timer: setTimeout(() => {
          h.acknowledged = true;
          h.resolve(
            result(`STILL RUNNING. Call ${POLL} with callId ${call.id}.`),
          );
        }, this.options.pollMs ?? 20_000),
      };
      t.handoff = h;
      t.reply = undefined;
      reply.call(call);
      h.prefix = signature([...t.request.messages, reply.message]);
      return;
    }
  }
}

export function createBridge(
  options: BridgeOptions,
  models: ReadonlyMap<string, AgyModelEntry>,
) {
  const cells = new Map<string, Cell>();
  let disposed = false;
  const sweep = setInterval(() => {
    for (const [key, cell] of cells)
      if (cell.dead || (!cell.busy && Date.now() - cell.usedAt > 5 * 60_000)) {
        cell.close();
        cells.delete(key);
      }
  }, 60_000);
  sweep.unref();
  function streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    opts?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const reply = new Reply(model);
    const key = opts?.sessionId || randomUUID();
    const pick = models.get(model.id);
    try {
      if (disposed || !pick)
        throw new Error(
          "Antigravity provider is not available for this model.",
        );
      // Model-only calls and compaction usually have no declared tools. Keep them apart from chat state.
      const request = project(context, Boolean(opts?.sessionId));
      trace(
        `Pi catalog: ${request.tools.size} tools; read ${request.tools.has("read") ? "available" : "absent"}`,
      );
      const stateKey =
        key +
        ":" +
        model.id +
        (request.messages.at(-1)?.role === "user" && !request.tools.size
          ? ":plain"
          : "");
      let cell = cells.get(stateKey);
      if (cell?.busy) {
        if (cell.resume(reply, request, opts)) return reply.stream;
        // Recover from durable history after an image handoff or an interrupted turn.
        if (cell.dead || request.messages.at(-1)?.role === "user") {
          cell.close();
          cells.delete(stateKey);
          cell = undefined;
        } else
          throw new Error(
            "Antigravity cannot match this reply to the active Pi tool call.",
          );
      }
      // A Pi tool can outlive the ACP process, a module reload, or a server restart.
      const last = request.messages.at(-1);
      if (
        !cell?.busy &&
        last?.role === "toolResult" &&
        last.toolCallId.startsWith("agy_")
      ) {
        // The tool has already run. A fresh session gets its result as history, not a new call.
        cell?.close();
        cells.delete(stateKey);
        cell = undefined;
      }
      const profile = hash([
        options.sendSystemPrompt === false ? "" : request.system,
        [...request.tools.values()],
      ]);
      if (
        !cell?.alive ||
        cell.profile !== profile ||
        cell.expected !== signature(request.messages.slice(0, -1))
      ) {
        cell?.close();
        cells.delete(stateKey);
        if (cells.size >= 12) {
          const idle = [...cells]
            .filter(([, v]) => !v.busy)
            .sort(([, a], [, b]) => a.usedAt - b.usedAt)[0];
          if (!idle)
            throw new Error(
              "Antigravity is busy. Wait for an active turn to finish.",
            );
          idle[1].close();
          cells.delete(idle[0]);
        }
        cell = new Cell(profile, options);
        cells.set(stateKey, cell);
      }
      void cell.run(reply, request, pick, opts).finally(() => {
        if ((!opts?.sessionId || cell.dead) && cells.get(stateKey) === cell) {
          cell.close();
          cells.delete(stateKey);
        }
      });
    } catch (error) {
      reply.finish(
        "error",
        error instanceof Error ? error.message : "Antigravity request failed.",
      );
    }
    return reply.stream;
  }
  return {
    streamSimple,
    dispose() {
      disposed = true;
      clearInterval(sweep);
      for (const cell of cells.values()) cell.close("aborted");
      cells.clear();
    },
  };
}
