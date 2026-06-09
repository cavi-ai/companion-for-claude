// Pure (Obsidian-free) per-message chat-control state and the logic that turns
// it into the model-aware request fields. Tested directly; the ChatView owns
// the UI and the provider owns the wire format.

import { capabilitiesFor, clampEffort, type ModelCapabilities } from "./capabilities";

export interface ChatControls {
  /** Model id selected in the chat header (overrides settings default for the session). */
  model: string;
  /** Extended thinking requested by the user. */
  thinking: boolean;
  /** Effort level for thinking/agentic depth (only used when the model supports effort). */
  effort: string;
  /** Render the model's reasoning in a collapsible block. */
  showThinking: boolean;
  /** Sampling temperature (only used when the model accepts it). null = model default. */
  temperature: number | null;
  /** Per-message max output tokens override. null = use settings default. */
  maxTokens: number | null;
}

export function defaultChatControls(model: string): ChatControls {
  return { model, thinking: false, effort: "high", showThinking: true, temperature: null, maxTokens: null };
}

/** The request-shaping fields derived from controls + the active model's capabilities. */
export interface RequestShape {
  /** `thinking` object for the request body, or undefined when not applicable. */
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  /** `output_config` object (currently just effort), or undefined. */
  outputConfig?: { effort: string };
  /** Whether to display `display:"summarized"` reasoning (adaptive models only). */
  thinkingDisplay?: "summarized" | "omitted";
  /** Temperature to send, or undefined when the model rejects it / user left it default. */
  temperature?: number;
  /** Resolved max output tokens. */
  maxTokens: number;
}

/**
 * Turn the user's controls into concrete request fields for the active model,
 * dropping anything that model would reject. `fallbackMaxTokens` is the settings
 * default used when the per-message override is null. `budgetFraction` decides
 * how much of max_tokens to give a budget-style thinking model.
 */
export function shapeRequest(
  controls: ChatControls,
  fallbackMaxTokens: number,
  caps: ModelCapabilities = capabilitiesFor(controls.model),
): RequestShape {
  const maxTokens = controls.maxTokens && controls.maxTokens > 0 ? controls.maxTokens : fallbackMaxTokens;
  const shape: RequestShape = { maxTokens };

  // ---- thinking ----
  if (controls.thinking) {
    if (caps.thinking === "adaptive") {
      shape.thinking = { type: "adaptive" };
      shape.thinkingDisplay = controls.showThinking ? "summarized" : "omitted";
    } else if (caps.thinking === "budget") {
      // Older models: a fixed budget that must be < max_tokens (min 1024).
      const budget = Math.max(1024, Math.min(Math.floor(maxTokens * 0.5), maxTokens - 1));
      shape.thinking = { type: "enabled", budget_tokens: budget };
    }
    // caps.thinking === "none": thinking unsupported — emit nothing.
  } else if (caps.thinking === "adaptive") {
    // Explicitly disable so adaptive models don't silently think.
    shape.thinking = { type: "disabled" };
  }

  // ---- effort ----
  if (caps.effort) {
    const eff = clampEffort(caps, controls.effort);
    if (eff) shape.outputConfig = { effort: eff };
  }

  // ---- temperature ----
  // Only send when the model accepts it, the user set one, AND thinking is off
  // (thinking models ignore/!allow sampling params).
  if (caps.temperature && controls.temperature !== null && !controls.thinking) {
    shape.temperature = controls.temperature;
  }

  return shape;
}
