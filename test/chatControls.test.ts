import { describe, it, expect } from "vitest";
import { defaultChatControls, knobVisibility, shapeRequest, type ChatControls } from "../src/claude/chatControls";
import { capabilitiesFor } from "../src/claude/capabilities";

const ctl = (over: Partial<ChatControls>): ChatControls => ({ ...defaultChatControls("claude-opus-4-8"), ...over });

describe("shapeRequest — max tokens", () => {
  it("uses the per-message override when set, else the fallback", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", maxTokens: 9000 }), 4096).maxTokens).toBe(9000);
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", maxTokens: null }), 4096).maxTokens).toBe(4096);
  });
});

describe("shapeRequest — thinking", () => {
  it("adaptive model + thinking on → adaptive + summarized display", () => {
    const s = shapeRequest(ctl({ model: "claude-opus-4-8", thinking: true, showThinking: true }), 4096);
    expect(s.thinking).toEqual({ type: "adaptive" });
    expect(s.thinkingDisplay).toBe("summarized");
  });
  it("adaptive model + thinking on + showThinking off → omitted display", () => {
    const s = shapeRequest(ctl({ model: "claude-opus-4-8", thinking: true, showThinking: false }), 4096);
    expect(s.thinkingDisplay).toBe("omitted");
  });
  it("adaptive model + thinking off → explicitly disabled", () => {
    const s = shapeRequest(ctl({ model: "claude-sonnet-4-6", thinking: false }), 4096);
    expect(s.thinking).toEqual({ type: "disabled" });
  });
  it("always-thinking model + thinking off → no thinking field (disabled would 400), effort still sent", () => {
    for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
      const s = shapeRequest(ctl({ model, thinking: false, effort: "medium" }), 4096);
      expect(s.thinking).toBeUndefined();
      expect(s.outputConfig).toEqual({ effort: "medium" });
    }
  });
  it("always-thinking model keeps xhigh effort with the Think toggle off", () => {
    expect(shapeRequest(ctl({ model: "claude-opus-5-5", thinking: false, effort: "xhigh" }), 4096).outputConfig).toEqual({ effort: "xhigh" });
  });
  it("always-thinking model + show reasoning → adaptive with summarized display", () => {
    const s = shapeRequest(ctl({ model: "claude-fable-5-1", thinking: true, showThinking: true }), 4096);
    expect(s.thinking).toEqual({ type: "adaptive" });
    expect(s.thinkingDisplay).toBe("summarized");
  });
  it("budget model + thinking on → enabled with budget < max_tokens, ≥ 1024", () => {
    const s = shapeRequest(ctl({ model: "claude-sonnet-4-5", thinking: true, maxTokens: 8000 }), 4096);
    expect(s.thinking?.type).toBe("enabled");
    const b = (s.thinking as { budget_tokens: number }).budget_tokens;
    expect(b).toBeGreaterThanOrEqual(1024);
    expect(b).toBeLessThan(8000);
  });
  it("budget model at the floor → budget still < max_tokens", () => {
    const b = (shapeRequest(ctl({ model: "claude-sonnet-4-5", thinking: true, maxTokens: 1025 }), 4096).thinking as { budget_tokens: number }).budget_tokens;
    expect(b).toBeGreaterThanOrEqual(1024);
    expect(b).toBeLessThan(1025);
  });
  it("budget model with max_tokens too small → omits thinking instead of sending an invalid budget", () => {
    // budget_tokens must be ≥ 1024 and < max_tokens, so nothing valid fits at ≤ 1024.
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-5", thinking: true, maxTokens: 1024 }), 4096).thinking).toBeUndefined();
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-5", thinking: true, maxTokens: 512 }), 4096).thinking).toBeUndefined();
  });
  it("unknown model → no thinking field even when toggled on", () => {
    const s = shapeRequest(ctl({ model: "my-local-llama", thinking: true }), 4096);
    expect(s.thinking).toBeUndefined();
  });
});

describe("shapeRequest — effort", () => {
  it("emits clamped effort for effort-capable models", () => {
    expect(shapeRequest(ctl({ model: "claude-opus-4-8", effort: "max" }), 4096).outputConfig).toEqual({ effort: "max" });
    // sonnet has no "max" → clamps to high
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", effort: "max" }), 4096).outputConfig).toEqual({ effort: "high" });
  });
  it("clamps Opus 5 to high when thinking is disabled", () => {
    expect(shapeRequest(ctl({ model: "claude-opus-5", thinking: false, effort: "max" }), 4096).outputConfig).toEqual({ effort: "high" });
    expect(shapeRequest(ctl({ model: "claude-opus-5", thinking: true, effort: "max" }), 4096).outputConfig).toEqual({ effort: "max" });
  });
  it("omits effort for models that don't support it", () => {
    expect(shapeRequest(ctl({ model: "claude-haiku-4-5", effort: "high" }), 4096).outputConfig).toBeUndefined();
  });
});

describe("shapeRequest — temperature gating", () => {
  it("sends temperature only when the model accepts it and thinking is off", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", temperature: 0.3, thinking: false }), 4096).temperature).toBe(0.3);
  });
  it("drops temperature on models that reject it (Opus 4.8)", () => {
    expect(shapeRequest(ctl({ model: "claude-opus-4-8", temperature: 0.3, thinking: false }), 4096).temperature).toBeUndefined();
  });
  it("drops temperature on Sonnet 5", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-5", temperature: 0.3, thinking: false }), 4096).temperature).toBeUndefined();
  });
  it("drops temperature when thinking is on", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", temperature: 0.3, thinking: true }), 4096).temperature).toBeUndefined();
  });
  it("drops temperature when user left it at default (null)", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", temperature: null }), 4096).temperature).toBeUndefined();
  });
});

describe("knobVisibility", () => {
  const vis = (model: string, thinking: boolean) => knobVisibility(capabilitiesFor(model), ctl({ model, thinking }));
  it("adaptive model shows effort and reasoning only while Think is on", () => {
    expect(vis("claude-opus-5", false)).toEqual({ think: true, effort: false, showReasoning: false });
    expect(vis("claude-opus-5", true)).toEqual({ think: true, effort: true, showReasoning: true });
  });
  it("always-thinking model shows effort even with Think off", () => {
    expect(vis("claude-opus-5-5", false)).toEqual({ think: true, effort: true, showReasoning: false });
    expect(vis("claude-fable-5-1", true)).toEqual({ think: true, effort: true, showReasoning: true });
  });
  it("model without thinking shows no thinking knobs", () => {
    expect(vis("some-custom-model", true)).toEqual({ think: false, effort: false, showReasoning: false });
  });
  it("Haiku shows Think and reasoning but no effort", () => {
    expect(vis("claude-haiku-4-5", true)).toEqual({ think: true, effort: false, showReasoning: true });
  });
});
