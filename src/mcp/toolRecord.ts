// One tool, declared once: what it advertises, whether it changes the vault, why it may be unavailable, and how it runs. Pure.

import type { McpToolDef } from "./protocol";

export interface ToolRecord {
  def: McpToolDef;
  /** Changes the vault. Required, so every tool states it; advertised as `annotations.readOnlyHint`. */
  writes: boolean;
  /** Why the tool is not offered right now (a setting is off); absent while it is offered. */
  unavailable?: string;
  run(args: Record<string, unknown>): Promise<string>;
}

/** The definition a client sees, with its write flag as the MCP read-only annotation. */
export function advertise(record: ToolRecord): McpToolDef {
  return { ...record.def, annotations: { ...record.def.annotations, readOnlyHint: !record.writes } };
}
