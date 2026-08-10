// Owns the plugin's external MCP client sessions: connect configured servers
// lazily, cache their tool lists, route namespaced calls back. Obsidian-facing
// (requestUrl, Platform); the protocol and transports are pure.

import { Platform, requestUrl } from "obsidian";
import { McpClientSession, type McpTransport } from "./client";
import { parseExternalToolName, type ExternalServerTools } from "./external";
import { createHttpMcpTransport } from "./httpTransport";
import type { McpToolDef } from "./protocol";
import type { McpServerConfig } from "../types";

interface Connected {
  session: McpClientSession;
  /** Tool name → call. */
  tools: McpToolDef[];
  /** Sanitized server name as exposed in mcp__<name>__<tool>. */
  exposedAs: string;
}

export class ExternalMcpManager {
  private connected = new Map<string, Connected>();
  private inFlight = new Map<string, { generation: number; promise: Promise<Connected | null> }>();
  private errors = new Map<string, string>();
  private generation = 0;

  constructor(private configs: () => McpServerConfig[]) {}

  /** Last connection error per server name (for the settings status line). */
  errorFor(name: string): string | undefined {
    return this.errors.get(name);
  }

  private async connect(config: McpServerConfig): Promise<Connected> {
    let transport: McpTransport;
    if (config.transport === "http") {
      const url = config.url.trim();
      if (!url) throw new Error("No server URL set.");
      transport = createHttpMcpTransport(url, {}, async (req) => {
        const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
        return { status: res.status, headers: { ...res.headers }, body: res.text };
      });
    } else {
      if (Platform.isMobile) throw new Error("stdio servers run only on desktop — use an HTTP server URL on mobile.");
      const command = config.command.trim();
      if (!command) throw new Error("No server command set.");
      const { createStdioMcpTransport } = await import("./stdioTransport");
      transport = await createStdioMcpTransport(command, config.args.trim() ? config.args.trim().split(/\s+/) : []);
    }
    const session = new McpClientSession(transport);
    const tools = await session.listTools();
    return { session, tools, exposedAs: config.name.trim() };
  }

  private async ensure(config: McpServerConfig): Promise<Connected | null> {
    const key = config.name.trim();
    const cached = this.connected.get(key);
    if (cached) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    const generation = this.generation;
    const entry: { generation: number; promise: Promise<Connected | null> } = {
      generation,
      promise: Promise.resolve(null),
    };
    entry.promise = (async () => {
      try {
        const conn = await this.connect(config);
        if (generation !== this.generation) {
          await conn.session.close().catch(() => {});
          return null;
        }
        this.connected.set(key, conn);
        this.errors.delete(key);
        return conn;
      } catch (e) {
        if (generation === this.generation) this.errors.set(key, e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, entry);
    return entry.promise;
  }

  /** Every enabled server's tools (connecting lazily); unreachable servers are skipped. */
  async servers(): Promise<ExternalServerTools[]> {
    const out: ExternalServerTools[] = [];
    for (const config of this.configs()) {
      if (!config.enabled || !config.name.trim()) continue;
      const conn = await this.ensure(config);
      if (conn) out.push({ server: conn.exposedAs, tools: conn.tools });
    }
    return out;
  }

  /** Call an mcp__<server>__<tool> name routed back to its server. */
  async call(externalName: string, args: Record<string, unknown>): Promise<string> {
    const parsed = parseExternalToolName(externalName);
    if (!parsed) throw new Error(`Not an external MCP tool: ${externalName}`);
    for (const [key, conn] of this.connected) {
      if (key === parsed.server || conn.exposedAs === parsed.server) {
        const result = await conn.session.callTool(parsed.tool, args);
        if (result.isError) throw new Error(result.text || `Tool ${parsed.tool} failed.`);
        return result.text;
      }
    }
    throw new Error(`MCP server not connected: ${parsed.server}`);
  }

  /** One-shot settings test: connect (fresh) and report the tool count. */
  async test(config: McpServerConfig): Promise<{ ok: boolean; message: string }> {
    // A manual test is an explicit fresh connection and supersedes any lazy
    // discovery still in flight for the previous configuration.
    const generation = ++this.generation;
    try {
      const key = config.name.trim();
      const existing = this.connected.get(key);
      if (existing) await existing.session.close().catch(() => {});
      this.connected.delete(key);
      const conn = await this.connect(config);
      if (generation !== this.generation) {
        await conn.session.close().catch(() => {});
        return { ok: false, message: "Connection test was cancelled." };
      }
      this.connected.set(key, conn);
      this.errors.delete(key);
      return { ok: true, message: `Connected — ${conn.tools.length} tool${conn.tools.length === 1 ? "" : "s"} exposed.` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.errors.set(config.name.trim(), message);
      return { ok: false, message };
    }
  }

  /** Drop every session (settings changed servers / plugin unload). */
  async close(): Promise<void> {
    this.generation++;
    const connected = Array.from(this.connected.values());
    const pending = Array.from(this.inFlight.values(), ({ promise }) => promise);
    this.connected.clear();
    this.inFlight.clear();
    await Promise.all([
      ...connected.map((conn) => conn.session.close().catch(() => {})),
      ...pending,
    ]);
  }
}
