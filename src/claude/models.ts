import type { ClaudeModel } from "../types";

// Curated default list. Users can always type a custom model id in settings,
// which takes precedence over this list. Keep these in sync with the public
// Anthropic Messages API model identifiers.
export const CLAUDE_MODELS: ClaudeModel[] = [
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    hint: "Most capable — deep reasoning, best artifacts",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    hint: "Balanced default — fast and strong",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    hint: "Fastest / cheapest — quick edits and Q&A",
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    hint: "Claude 5 family",
  },
];

/** A cheap, always-valid model id for connection tests. */
export const PING_MODEL = "claude-haiku-4-5-20251001";

export function resolveModelId(model: string, customModel: string): string {
  const custom = customModel.trim();
  if (custom.length > 0) return custom;
  const selected = model.trim();
  // Never send an empty model id (the API 400s). Fall back to a known-good default.
  return selected.length > 0 ? selected : CLAUDE_MODELS[0]!.id;
}

export function modelLabel(id: string): string {
  return CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id;
}
