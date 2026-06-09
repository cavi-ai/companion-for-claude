import { describe, it, expect } from "vitest";
import { defaultChatControls, shapeRequest, type ChatControls } from "../src/claude/chatControls";

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
  it("budget model + thinking on → enabled with budget < max_tokens, ≥ 1024", () => {
    const s = shapeRequest(ctl({ model: "claude-sonnet-4-5", thinking: true, maxTokens: 8000 }), 4096);
    expect(s.thinking?.type).toBe("enabled");
    const b = (s.thinking as { budget_tokens: number }).budget_tokens;
    expect(b).toBeGreaterThanOrEqual(1024);
    expect(b).toBeLessThan(8000);
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
  it("drops temperature when thinking is on", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", temperature: 0.3, thinking: true }), 4096).temperature).toBeUndefined();
  });
  it("drops temperature when user left it at default (null)", () => {
    expect(shapeRequest(ctl({ model: "claude-sonnet-4-6", temperature: null }), 4096).temperature).toBeUndefined();
  });
});
