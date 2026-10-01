export type ResearchModel = "chat" | "claude" | "local" | "off";
export const RESEARCH_MODELS: readonly ResearchModel[] = ["chat", "claude", "local", "off"];

export function researchCoordinatorMode(model: ResearchModel): "current" | "claude" | "local" | "disabled" {
  if (model === "chat") return "current";
  if (model === "off") return "disabled";
  return model;
}

function mapLegacy(value: unknown): ResearchModel | undefined {
  if (value === "claude") return "claude";
  if (value === "local") return "local";
  if (value === "disabled") return "off";
  return undefined;
}

export function migrateResearchModel(
  persisted: { intelligenceNarrator?: unknown; discoveryReranker?: unknown; researchModel?: unknown } | null | undefined,
): ResearchModel | undefined {
  if (!persisted) return undefined;
  if (RESEARCH_MODELS.includes(persisted.researchModel as ResearchModel)) return undefined;
  return mapLegacy(persisted.intelligenceNarrator) ?? mapLegacy(persisted.discoveryReranker);
}

export interface ResearchModelStatus { model: ResearchModel; providerLabel: string; modelId: string; available: boolean }

export function researchModelChip(status: ResearchModelStatus): { text: string; available: boolean } {
  if (status.model === "off") return { text: "AI off", available: true };
  if (!status.available) return { text: `AI · set up ${status.providerLabel}`, available: false };
  return { text: `AI · ${status.providerLabel} · ${status.modelId}`, available: true };
}

export function researchModelOptions(
  chat: { providerLabel: string; modelId: string },
  local: { modelId: string },
): Record<ResearchModel, string> {
  return {
    chat: `Same as chat — ${chat.providerLabel} · ${chat.modelId}`,
    claude: "Claude API",
    local: `Local — ${local.modelId}`,
    off: "Off",
  };
}
