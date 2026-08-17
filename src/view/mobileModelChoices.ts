import { CLAUDE_MODELS } from "../claude/models";
import { mergeDetectedModels } from "../providers/localModels";
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
  /** Models the endpoint reported; empty is fine (falls back to the configured id). */
  openaiCompatModels?: string[];
}): MobileModelChoice[] {
  const choices: MobileModelChoice[] = CLAUDE_MODELS.map((model) => ({
    value: model.id,
    label: model.label,
    provider: "claude",
  }));
  for (const model of mergeDetectedModels(input.ollamaModels, input.configuredOllamaModel)) {
    choices.push({ value: `ollama:${model}`, label: `${model} · local`, provider: "local" });
  }
  if (input.openaiCompatHost.trim()) {
    for (const model of mergeDetectedModels(input.openaiCompatModels ?? [], input.openaiCompatModel)) {
      choices.push({ value: `custom:${model}`, label: `${model} · endpoint`, provider: "custom" });
    }
  }
  return choices;
}
