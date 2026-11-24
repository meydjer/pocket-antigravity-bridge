import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export const SERVER = "pi-bridge";
export const HEADER = "x-bridge-token";
export const POLL = "bridge_poll_result";
export const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
export function trace(event: string) {
  if (process.env.PI_POCKET_AGY_TRACE === "1")
    process.stderr.write(`[antigravity-bridge] ${event}\n`);
}
export type Dict = Record<string, unknown>;
export function dict(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
}
export type McpTool = {
  name: string;
  description: string;
  inputSchema: object;
};
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export type McpResult = { content: McpContent[]; isError?: boolean };
export const result = (text: string, isError = false): McpResult => ({
  content: [{ type: "text", text }],
  isError,
});

// Stateless Streamable HTTP: POST/JSON for requests, 202 for notifications.
// No SSE stream or session header is needed for this request/response-only server.
export async function openMcp(
  list: () => McpTool[],
  call: (name: string, args: Dict) => Promise<McpResult>,
) {
  const key = randomBytes(32).toString("hex");
  const secret = Buffer.from(key);
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 15_000 },
    (req, res) => {
      void respond(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
    },
  );
  let inFlight = 0;
  let host = "";
  async function respond(req: IncomingMessage, res: ServerResponse) {
    const token = req.headers[HEADER];
    res.on("finish", () =>
      trace(
        `MCP HTTP: ${req.method === "POST" ? "POST" : "other"} ${res.statusCode}`,
      ),
    );
    if (req.url !== "/mcp" || req.headers.host !== host) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      res.writeHead(403).end();
      return;
    }
    if (
      typeof token !== "string" ||
      Buffer.byteLength(token) !== secret.length ||
      !timingSafeEqual(Buffer.from(token), secret)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (
      !(req.headers["content-type"] ?? "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      res.writeHead(415).end();
      return;
    }
    if (inFlight >= 16) {
      res.writeHead(429).end();
      return;
    }
    inFlight++;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(part);
      }
      const msg = dict(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const { id, method } = msg;
      if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
        res.writeHead(400).end();
        return;
      }
      if (id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (typeof id !== "number" && typeof id !== "string" && id !== null) {
        res.writeHead(400).end();
        return;
      }
      const params = dict(msg.params);
      let reply: Dict;
      switch (method) {
        case "initialize":
          trace("MCP initialize");
          reply = {
            result: {
              protocolVersion:
                typeof params.protocolVersion === "string" &&
                versions.includes(params.protocolVersion)
                  ? params.protocolVersion
                  : versions[0],
              serverInfo: { name: SERVER, version: "1.0.0" },
              capabilities: { tools: {} },
            },
          };
          break;
        case "ping":
          reply = { result: {} };
          break;
        case "tools/list": {
          const tools = list();
          trace(`MCP list: ${tools.length} tools`);
          reply = { result: { tools } };
          break;
        }
        case "tools/call":
          trace("MCP tool call");
          reply = {
            result:
              typeof params.name === "string"
                ? await call(params.name, dict(params.arguments))
                : result("Missing tool name.", true),
          };
          break;
        default:
          reply = { error: { code: -32601, message: "Method not found" } };
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    } finally {
      inFlight--;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Cannot open the local MCP bridge.");
  }
  host = `127.0.0.1:${address.port}`;
  server.unref();
  return {
    spec: {
      name: SERVER,
      type: "http",
      url: `http://${host}/mcp`,
      headers: [{ name: HEADER, value: key }],
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
