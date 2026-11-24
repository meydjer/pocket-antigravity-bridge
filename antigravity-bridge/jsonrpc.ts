// JSON-RPC transport adapted from @firespoon/pi-antigravity-bridge v1.10.16 (MIT).
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcIncoming {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export type SendFn = (frame: string) => void;

export interface JsonRpcSessionOptions {
  send: SendFn;
  /** Server-to-client request (has method + id). Return the result value, or
   *  throw to answer with a JSON-RPC error. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Server-to-client notification (method, no id). */
  onNotification?: (method: string, params: unknown) => void;
  /** Unparseable line (logged, never fatal). */
  onParseError?: (line: string) => void;
  /** Frame-cap breach: the peer flooded stdout with no newline. The session
   *  aborts itself; the transport must kill the process. */
  onOverflow?: (detail: string) => void;
  /** Default timeout for requests without an explicit one (ms). 0 = none. */
  defaultTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

export class JsonRpcSession {
  #send: SendFn;
  #opts: JsonRpcSessionOptions;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #aborted = false;
  #overflowed = false;
  #lineBuf = "";
  parseErrors = 0;

  constructor(opts: JsonRpcSessionOptions) {
    this.#opts = opts;
    this.#send = opts.send;
  }

  /** Feed raw transport bytes. Stdio chunks are NOT newline-aligned: bytes
   *  are buffered and only complete lines are parsed (a frame split across a
   *  64KB pipe boundary must never be dropped). The buffer is capped: a peer
   *  flooding stdout with no newline breaches the cap and the session dies
   *  (onOverflow + abortAll), it never grows without bound. */
  feed(chunk: string): void {
    if (this.#overflowed) return;
    this.#lineBuf += chunk;
    if (this.#lineBuf.length > MAX_FRAME_BYTES) {
      const detail = `${this.#lineBuf.length} bytes buffered with no newline (cap ${MAX_FRAME_BYTES})`;
      this.#overflow(detail);
      return;
    }
    const lines = this.#lineBuf.split("\n");
    this.#lineBuf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // Known foreign noise (e.g. the Chromium launcher behind a browser
      // login) is dropped before parsing, not counted as a parse error.

      let msg: JsonRpcIncoming;
      try {
        msg = JSON.parse(line) as JsonRpcIncoming;
      } catch {
        this.parseErrors++;
        continue;
      }
      if (
        msg &&
        typeof msg === "object" &&
        (typeof msg.method === "string" || typeof msg.id === "number")
      )
        this.#handleMessage(msg);
    }
  }

  #overflow(detail: string): void {
    this.#overflowed = true;
    this.#lineBuf = "";
    // Aborting first gives pending requests the typed overflow reason; the
    // transport's own teardown afterwards is a no-op on the empty map.
    this.abortAll(`stdout frame overflow: ${detail}`);
    this.#opts.onOverflow?.(detail);
  }

  #handleMessage(msg: JsonRpcIncoming): void {
    // Response to one of our requests.
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const id = Number(msg.id);
      const pending = this.#pending.get(id);
      if (!pending) return; // late response to an aborted request: drop
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new JsonRpcResponseError(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method === undefined) return;
    // Server-to-client request: must be answered with the same id. The
    // handler is always invoked through Promise.resolve() so a synchronous
    // throw can never escape into the reader loop.
    if (msg.id !== undefined && msg.id !== null) {
      const id = msg.id;
      const handler = this.#opts.onRequest;
      if (!handler) {
        this.#sendError(
          id,
          -32601,
          `client does not support method: ${msg.method}`,
        );
        return;
      }
      void Promise.resolve()
        .then(() => handler(msg.method as string, msg.params))
        .then((result) => {
          if (this.#aborted) return;
          this.#send(
            JSON.stringify({ jsonrpc: "2.0", id, result: result ?? {} }),
          );
        })
        .catch((err: unknown) => {
          if (this.#aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          this.#sendError(id, -32000, message);
        });
      return;
    }
    // Notification.
    this.#opts.onNotification?.(msg.method, msg.params);
  }

  #sendError(id: number | string, code: number, message: string): void {
    if (this.#aborted) return;
    this.#send(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    );
  }

  /** Send a request. Resolves with the result value; rejects on error
   *  responses (JsonRpcResponseError), timeouts, or abortAll(). */
  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.#aborted) return Promise.reject(new Error("connection aborted"));
    const id = this.#nextId++;
    const effective = timeoutMs ?? this.#opts.defaultTimeoutMs ?? 0;
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject, method };
      if (effective > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(
            new Error(`ACP request timed out after ${effective}ms: ${method}`),
          );
        }, effective);
      }
      this.#pending.set(id, pending);
      this.#send(
        JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      );
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#aborted) return;
    this.#send(
      JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
    );
  }

  /** Reject every pending request (Gate D teardown). The transport is going
   *  away; nothing will ever be written again. */
  abortAll(reason: string): void {
    this.#aborted = true;
    for (const [id, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} (request: ${pending.method})`));
      this.#pending.delete(id);
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}

/** A JSON-RPC `error` result, preserving code + data (the -32602 `loc` paths
 *  and the -32601 method name are correction oracles; see the reference doc). */
export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: JsonRpcErrorShape) {
    super(error.message);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}
