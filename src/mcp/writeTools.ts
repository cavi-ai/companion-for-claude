// Canonical registry of vault-mutating tools. Single source of truth shared by
// the agent-side write gate (agent/tools.ts) and the MCP server's own gating
// (mcp/vaultTools.ts), so a write tool can't be added to one gate and missed by
// the other — the failure mode of hand-maintained parallel lists. Pure: no
// Obsidian, safe to import from the agent layer.

/** Tools that mutate the vault (notes, canvas, bases, ontology). */
export const VAULT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "note_create",
  "note_append",
  "note_update",
  "note_patch",
  "update_frontmatter",
  "note_move",
  "canvas_create",
  "base_create",
  "ontology_propose",
]);
