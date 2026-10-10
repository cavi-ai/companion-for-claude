// Which tools a run offers and how each call is handled, for every run kind and transport. Pure.

import { parseExternalToolName } from "../mcp/external";
import type { McpToolDef } from "../mcp/protocol";

/**
 * off: no tools. plan: vault reads only. chat: reads, confirmed writes, reviewed edits, and external
 * MCP tools. propose: reads plus queued edit proposals (standing orders).
 */
export type ToolRunKind = "off" | "plan" | "chat" | "propose";

/** run: execute. confirm: the user approves first. propose: route to edit review. deny: refuse. */
export type ToolDecision = "run" | "confirm" | "propose" | "deny";

export interface ToolAccess {
  readonly kind: ToolRunKind;
  /** The candidates this run offers, in order: every tool whose calls are not denied. */
  offered<T extends { name: string }>(candidates: readonly T[]): T[];
  decide(name: string): ToolDecision;
}

/** Whether a tool changes the vault; a definition without the read-only annotation counts as a write. */
export function isWriteTool(def: McpToolDef): boolean {
  return def.annotations?.readOnlyHint !== true;
}

/** Reviewed edit proposals: never a write, since the user accepts each hunk before the vault changes. */
export const PROPOSE_EDIT_DEF: McpToolDef = {
  name: "propose_note_edit",
  description:
    "Propose targeted edits to an existing note. The user reviews a diff and accepts or rejects each change; the result reports what was actually applied. Each old_str must match the note exactly once — include surrounding lines to disambiguate. Prefer this over rewriting note content in chat.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the note to edit (e.g. 'Folder/Note.md')." },
      edits: {
        type: "array",
        description: "Exact string replacements, each matching the note exactly once.",
        items: {
          type: "object",
          properties: {
            old_str: { type: "string", description: "Exact existing text to replace (unique in the note)." },
            new_str: { type: "string", description: "Replacement text." },
          },
          required: ["old_str", "new_str"],
        },
      },
      description: { type: "string", description: "One-line summary of the intent, shown to the user above the diff." },
    },
    required: ["path", "edits"],
  },
  annotations: { readOnlyHint: true },
};

/**
 * `catalog` is the vault tools the run can reach right now; a vault call outside it is refused, and
 * each tool's write-ness comes from its own definition.
 */
export function toolAccess(kind: ToolRunKind, catalog: readonly McpToolDef[]): ToolAccess {
  const decide = (name: string): ToolDecision => {
    if (kind === "off") return "deny";
    if (name === PROPOSE_EDIT_DEF.name) return kind === "plan" ? "deny" : "propose";
    if (parseExternalToolName(name)) return kind === "chat" ? "run" : "deny";
    const tool = catalog.find((def) => def.name === name);
    if (!tool) return "deny";
    if (isWriteTool(tool)) return kind === "chat" ? "confirm" : "deny";
    return "run";
  };
  return {
    kind,
    offered: (candidates) => candidates.filter((tool) => decide(tool.name) !== "deny"),
    decide,
  };
}
