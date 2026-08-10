// Pure (Obsidian-free) model capability table. The chat controls query this to
// decide which knobs to show and how to shape the request, so a setting that
// would 400 on the active model is simply hidden instead of erroring.
//
// Grounded in the Anthropic Messages API behavior (verified against the
// Anthropic Platform docs, 2026-08-09):
//   - Opus 5 / 4.8 / 4.7 and Sonnet 5: non-default sampling parameters
//     (`temperature`/`top_p`/`top_k`) return 400;
//     `thinking:{type:"enabled",budget_tokens}` removed (400). Thinking is
//     adaptive-only; `effort` (low|medium|high|xhigh|max) is supported.
//   - Opus 5 also returns 400 when thinking is disabled with xhigh/max effort.
//   - Opus 4.6 / 4.5, Sonnet 4.6: adaptive thinking + `effort`. (Opus tier also
//     allows effort "max"/"xhigh".) `temperature` still accepted on these.
//   - Sonnet 4.5 and older: classic `temperature`; thinking via
//     `{type:"enabled",budget_tokens}`; no `effort`.
//   - Haiku 4.5: thinking adaptive, no `effort`.
//   - Unknown / custom ids: conservative defaults (temperature on, no
//     thinking/effort) so a request never includes a field that 400s.

export type ThinkingMode = "adaptive" | "budget" | "none";

export interface ModelCapabilities {
  /** `temperature` accepted by this model. */
  temperature: boolean;
  /** How thinking is requested: adaptive (4.6+), budget_tokens (older), or unsupported. */
  thinking: ThinkingMode;
  /** `output_config.effort` accepted (Opus 4.5+, Sonnet 4.6). */
  effort: boolean;
  /** `effort:"max"`/`"xhigh"` accepted (Opus tier only). */
  effortMax: boolean;
  /** Highest effort accepted while adaptive thinking is explicitly disabled. */
  maxEffortWithoutThinking?: "high";
}

const CONSERVATIVE: ModelCapabilities = { temperature: true, thinking: "none", effort: false, effortMax: false };

/** Normalize a model id to its family, stripping any dated snapshot suffix. */
function family(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/-\d{8}$/, "");
}

export function capabilitiesFor(modelId: string): ModelCapabilities {
  const f = family(modelId);

  // Opus 5 — full effort requires thinking at xhigh/max.
  if (f === "claude-opus-5") {
    return { temperature: false, thinking: "adaptive", effort: true, effortMax: true, maxEffortWithoutThinking: "high" };
  }
  // Opus 4.7 / 4.8 — no sampling params, adaptive thinking, full effort incl. max.
  if (f === "claude-opus-4-8" || f === "claude-opus-4-7") {
    return { temperature: false, thinking: "adaptive", effort: true, effortMax: true };
  }
  // Opus 4.5 / 4.6 — temperature still ok, adaptive thinking, effort incl. max.
  if (f === "claude-opus-4-6" || f === "claude-opus-4-5") {
    return { temperature: true, thinking: "adaptive", effort: true, effortMax: true };
  }
  // Sonnet 5 — sampling params removed; adaptive thinking + effort.
  if (f === "claude-sonnet-5") {
    return { temperature: false, thinking: "adaptive", effort: true, effortMax: false };
  }
  // Sonnet 4.6 — adaptive thinking + effort (no "max": Opus-tier only).
  if (f === "claude-sonnet-4-6") {
    return { temperature: true, thinking: "adaptive", effort: true, effortMax: false };
  }
  // Fable/Mythos always reason server-side; their sampling controls are also
  // rejected. Preserve the existing no-manual-thinking control shape here.
  if (f === "claude-fable-5" || f === "claude-mythos-5" || f === "claude-mythos-preview") {
    return { ...CONSERVATIVE, temperature: false };
  }
  // Haiku 4.5 — adaptive thinking, no effort.
  if (f === "claude-haiku-4-5") {
    return { temperature: true, thinking: "adaptive", effort: false, effortMax: false };
  }
  // Older Claude (Sonnet 4.5 / 4.0, Opus 4.0/4.1, 3.x) — classic budget thinking.
  if (/^claude-(sonnet|opus|haiku)-(4-5|4-1|4-0|3)/.test(f) || /^claude-3/.test(f)) {
    return { temperature: true, thinking: "budget", effort: false, effortMax: false };
  }
  // Unknown / custom — safest shape (no thinking/effort fields emitted).
  return CONSERVATIVE;
}

/** Effort levels valid for a model, in increasing order. Empty if unsupported. */
export function effortLevels(caps: ModelCapabilities): string[] {
  if (!caps.effort) return [];
  return caps.effortMax ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];
}

/** Clamp a requested effort to what the model allows; null when effort isn't supported. */
export function clampEffort(caps: ModelCapabilities, requested: string): string | null {
  const levels = effortLevels(caps);
  if (levels.length === 0) return null;
  if (levels.includes(requested)) return requested;
  return "high"; // sensible default that exists on every effort-capable model
}
