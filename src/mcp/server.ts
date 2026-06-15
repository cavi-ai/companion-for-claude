// eslint-disable-next-line import/no-nodejs-modules -- desktop-only MCP server; loaded only via a guarded dynamic import on desktop (see main.ts), never on mobile
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { handleRpc, validateRequest, err, RPC, type JsonRpcResponse, type ServerInfo } from "./protocol";
import type { VaultTools } from "./vaultTools";

export interface McpServerConfig {
  port: number;
  /** Bearer token required on every request. */
  token: string;
  serverInfo: ServerInfo;
}

export type LogFn = (level: "info" | "error", message: string) => void;

/**
 * A minimal MCP "Streamable HTTP" server bound to localhost. Accepts JSON-RPC
 * over POST /mcp and returns JSON responses. Designed for local clients
 * (Claude Code via http transport, Claude Desktop via mcp-remote).
 */
export class McpHttpServer {
  private server: Server | null = null;
  private activeRequests = 0;
  private handledRequests = 0;

  constructor(
    private config: McpServerConfig,
    private tools: VaultTools,
    private log: LogFn = () => {},
  ) {}

  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * The actual bound port, or null when not listening. When `config.port` is 0
   * the OS assigns an ephemeral port; this is how callers (and tests) discover
   * it.
   */
  address(): { port: number } | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? { port: a.port } : null;
  }

  stats(): { activeRequests: number; handledRequests: number } {
    return { activeRequests: this.activeRequests, handledRequests: this.handledRequests };
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!this.config.token.trim()) {
      throw new Error("MCP server requires a non-empty bearer token.");
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.onRequest(req, res));
      server.on("error", (e) => {
        this.server = null;
        reject(e);
      });
      // Bind to loopback only — never expose the vault on the network.
      server.listen(this.config.port, "127.0.0.1", () => {
        this.server = server;
        this.log("info", `MCP server listening on http://127.0.0.1:${this.config.port}/mcp`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    this.log("info", "MCP server stopped");
  }

  private setCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers["authorization"] as string | string[] | undefined;
    const bearer = Array.isArray(header) ? header[0] : header;
    return bearer === `Bearer ${this.config.token.trim()}`;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.activeRequests++;
    this.handledRequests++;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
    res.once("finish", release);
    res.once("close", release);

    this.setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!(req.url ?? "/").startsWith("/mcp")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp." }));
      return;
    }

    if (!this.authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: missing or invalid bearer token." }));
      return;
    }

    // A bare GET is used by some clients as a liveness/SSE probe.
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: this.config.serverInfo }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const body = await readBody(req).catch(() => null);
    if (body === null) {
      this.send(res, err(null, RPC.PARSE_ERROR, "Could not read request body"));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.send(res, err(null, RPC.PARSE_ERROR, "Invalid JSON"));
      return;
    }

    // Support JSON-RPC batches.
    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of parsed) {
        const r = await this.dispatch(item);
        if (r) responses.push(r);
      }
      this.send(res, responses);
      return;
    }

    const response = await this.dispatch(parsed);
    if (response === null) {
      res.writeHead(202); // notification accepted, no body
      res.end();
      return;
    }
    this.send(res, response);
  }

  private async dispatch(value: unknown): Promise<JsonRpcResponse | null> {
    const { req, error } = validateRequest(value);
    if (error || !req) return err((value as { id?: string | number })?.id ?? null, error?.code ?? RPC.INVALID_REQUEST, error?.message ?? "Invalid request");
    try {
      return await handleRpc(req, {
        serverInfo: this.config.serverInfo,
        tools: this.tools.definitions(),
        call: (name, args) => this.tools.call(name, args),
      });
    } catch (e) {
      this.log("error", `RPC error: ${e instanceof Error ? e.message : String(e)}`);
      return err(req.id, RPC.INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
  }

  private send(res: ServerResponse, payload: unknown): void {
    const json = JSON.stringify(payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    const MAX = 5 * 1024 * 1024; // 5 MB guard
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
