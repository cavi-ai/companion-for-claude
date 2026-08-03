import { CLAUDE_MODELS } from "../claude/models";
import type { ProviderId } from "../providers/types";

export interface MobileModelChoice {
  value: string;
  label: string;
  provider: "claude" | "local" | "custom";
}

export function isMobileModelChoiceActive(
  choice: MobileModelChoice,
  activeProvider: ProviderId,
  activeModel: string,
): boolean {
  if (choice.provider === "local") return activeProvider === "ollama" && choice.value === `ollama:${activeModel}`;
  if (choice.provider === "custom") return activeProvider === "openai-compat" && choice.value === `custom:${activeModel}`;
  return activeProvider === "anthropic" && choice.value === activeModel;
}

export function mobileModelChoices(input: {
  ollamaModels: string[];
  configuredOllamaModel: string;
  openaiCompatHost: string;
  openaiCompatModel: string;
}): MobileModelChoice[] {
  const choices: MobileModelChoice[] = CLAUDE_MODELS.map((model) => ({
    value: model.id,
    label: model.label,
    provider: "claude",
  }));
  const localModels = [...input.ollamaModels];
  if (input.configuredOllamaModel && !localModels.includes(input.configuredOllamaModel)) {
    localModels.unshift(input.configuredOllamaModel);
  }
  for (const model of localModels) {
    choices.push({ value: `ollama:${model}`, label: `${model} · local`, provider: "local" });
  }
  const endpointModel = input.openaiCompatModel.trim();
  if (input.openaiCompatHost.trim() && endpointModel) {
    choices.push({ value: `custom:${endpointModel}`, label: `${endpointModel} · endpoint`, provider: "custom" });
  }
  return choices;
}
