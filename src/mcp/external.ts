// Namespacing + registry for external MCP servers' tools in the agent loop:
// each server's tools are exposed as mcp__<server>__<tool> so they can never
// collide with vault tools or each other. Pure.

import type { McpToolDef } from "./protocol";
import type { AnthropicToolDef } from "../providers/types";

export interface ExternalServerTools {
  /** Configured server name (settings). */
  server: string;
  tools: McpToolDef[];
}

const PREFIX = "mcp__";
const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";

/** mcp__<server>__<tool> — the name the model sees and calls. */
export function externalToolName(server: string, tool: string): string {
  return `${PREFIX}${sanitize(server)}__${tool}`;
}

/** Split an external name back into (server, tool); null for non-external names. */
export function parseExternalToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep === -1) return null;
  if (sep <= 0 || sep === rest.length - 2) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** Anthropic tool defs for every connected server's tools, namespaced. */
export function externalAnthropicTools(servers: ExternalServerTools[]): AnthropicToolDef[] {
  const out: AnthropicToolDef[] = [];
  for (const { server, tools } of servers) {
    for (const tool of tools) {
      out.push({
        name: externalToolName(server, tool.name),
        description: `[${server}] ${tool.description}`,
        input_schema: tool.inputSchema,
      });
    }
  }
  return out;
}
