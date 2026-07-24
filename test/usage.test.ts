import { describe, it, expect } from "vitest";
import { estimateTokens, limitsFor, DEFAULT_LIMITS, contextGauge, addUsage, EMPTY_SESSION, sessionCost, formatTokens, formatCost, type SessionUsage } from "../src/usage/tokens";
import { mergeUsage, parseSseChunk } from "../src/claude/sse";

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("scales with length (~3.7 chars/token)", () => {
    expect(estimateTokens("x".repeat(37))).toBe(10);
  });
});

describe("limitsFor", () => {
  it("matches exact known model ids", () => {
    expect(limitsFor("claude-sonnet-4-6").contextWindow).toBe(1_000_000);
  });
  it("matches dated snapshots by family prefix", () => {
    expect(limitsFor("claude-sonnet-4-6-20250930").outputCostPerM).toBe(15);
  });
  it("falls back to defaults for unknown models", () => {
    expect(limitsFor("some-local-model")).toBe(DEFAULT_LIMITS);
  });
});

describe("contextGauge", () => {
  it("computes fraction and remaining against the window", () => {
    const g = contextGauge(50_000, "claude-sonnet-4-6", 10_000);
    expect(g.used).toBe(60_000);
    expect(g.window).toBe(1_000_000);
    expect(g.fraction).toBeCloseTo(0.06, 5);
    expect(g.remaining).toBe(940_000);
  });
  it("clamps fraction to 1 when over budget", () => {
    expect(contextGauge(2_000_000, "claude-sonnet-4-6", 0).fraction).toBe(1);
  });
});

describe("addUsage / sessionCost", () => {
  it("accumulates tokens and request count", () => {
    let s = { ...EMPTY_SESSION };
    s = addUsage(s, { input_tokens: 100, output_tokens: 50 });
    s = addUsage(s, { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30 });
    expect(s).toEqual({ inputTokens: 300, outputTokens: 130, cacheReadTokens: 30, cacheWriteTokens: 0, requests: 2 });
  });
  it("prices a session by model rates", () => {
    const s = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 };
    // sonnet: $3 in + $15 out = $18
    expect(sessionCost(s, "claude-sonnet-4-6")).toBeCloseTo(18, 5);
  });
});

describe("formatTokens / formatCost", () => {
  it("formats token magnitudes", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(42_000)).toBe("42k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
  it("formats costs with small-value handling", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("SSE usage extraction", () => {
  it("merges usage, preferring later defined values", () => {
    expect(mergeUsage({ input_tokens: 10 }, { output_tokens: 5 })).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: undefined,
      cache_creation_input_tokens: undefined,
    });
  });
  it("reads input_tokens from message_start and output_tokens from message_delta", () => {
    const start = `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1200 } } })}\n`;
    const delta = `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 340 } })}\n`;
    const r = parseSseChunk(start + delta);
    expect(r.usage?.input_tokens).toBe(1200);
    expect(r.usage?.output_tokens).toBe(340);
  });
});

describe("cache-aware session cost (spec 2026-07-05 §9)", () => {
  const session = (over: Partial<SessionUsage>): SessionUsage => ({ ...EMPTY_SESSION, ...over });

  it("prices plain input/output at base rates (sonnet: $3/$15 per M)", () => {
    const c = sessionCost(session({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), "claude-sonnet-4-6");
    expect(c).toBeCloseTo(3 + 15, 6);
  });

  it("prices cache writes at 1.25x and reads at 0.1x the input rate", () => {
    const c = sessionCost(session({ cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 }), "claude-sonnet-4-6");
    expect(c).toBeCloseTo(3 * 1.25 + 3 * 0.1, 6);
  });

  it("sums all four buckets", () => {
    const c = sessionCost(
      session({ inputTokens: 500_000, outputTokens: 200_000, cacheWriteTokens: 100_000, cacheReadTokens: 2_000_000 }),
      "claude-opus-4-8",
    );
    // opus 4.8: $5 in / $25 out per M
    expect(c).toBeCloseTo(0.5 * 5 + 0.2 * 25 + 0.1 * 5 * 1.25 + 2 * 5 * 0.1, 6);
  });

  it("accumulates cache_creation_input_tokens via addUsage", () => {
    const s = addUsage(EMPTY_SESSION, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 });
    expect(s.cacheWriteTokens).toBe(1000);
    expect(s.cacheReadTokens).toBe(2000);
  });

  it("tolerates persisted sessions without the cacheWriteTokens field", () => {
    const legacy = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 } as SessionUsage;
    expect(sessionCost(legacy, "claude-sonnet-4-6")).toBe(0);
    expect(addUsage(legacy, { cache_creation_input_tokens: 5 }).cacheWriteTokens).toBe(5);
  });
});
