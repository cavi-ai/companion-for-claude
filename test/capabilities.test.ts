import { describe, it, expect } from "vitest";
import { capabilitiesFor, effortLevels, clampEffort } from "../src/claude/capabilities";

describe("capabilitiesFor", () => {
  it("Opus 4.8 / 4.7 — no temperature, adaptive thinking, effort incl. max", () => {
    for (const id of ["claude-opus-4-8", "claude-opus-4-7"]) {
      const c = capabilitiesFor(id);
      expect(c.temperature).toBe(false);
      expect(c.thinking).toBe("adaptive");
      expect(c.effort).toBe(true);
      expect(c.effortMax).toBe(true);
    }
  });
  it("Opus 4.6 / 4.5 — temperature ok, adaptive thinking, effort incl. max", () => {
    for (const id of ["claude-opus-4-6", "claude-opus-4-5"]) {
      const c = capabilitiesFor(id);
      expect(c.temperature).toBe(true);
      expect(c.thinking).toBe("adaptive");
      expect(c.effortMax).toBe(true);
    }
  });
  it("Sonnet 4.6 — adaptive thinking + effort, no max", () => {
    const c = capabilitiesFor("claude-sonnet-4-6");
    expect(c.thinking).toBe("adaptive");
    expect(c.effort).toBe(true);
    expect(c.effortMax).toBe(false);
  });
  it("Haiku 4.5 — adaptive thinking, no effort (incl. dated snapshot)", () => {
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      const c = capabilitiesFor(id);
      expect(c.thinking).toBe("adaptive");
      expect(c.effort).toBe(false);
    }
  });
  it("Sonnet 4.5 / older — budget thinking, no effort, temperature ok", () => {
    const c = capabilitiesFor("claude-sonnet-4-5");
    expect(c.thinking).toBe("budget");
    expect(c.effort).toBe(false);
    expect(c.temperature).toBe(true);
  });
  it("unknown / custom id — conservative: temperature on, no thinking/effort", () => {
    const c = capabilitiesFor("my-local-llama");
    expect(c).toEqual({ temperature: true, thinking: "none", effort: false, effortMax: false });
  });
});

describe("effortLevels / clampEffort", () => {
  it("returns no levels when effort is unsupported", () => {
    expect(effortLevels(capabilitiesFor("claude-haiku-4-5"))).toEqual([]);
    expect(clampEffort(capabilitiesFor("claude-haiku-4-5"), "high")).toBeNull();
  });
  it("includes max only for Opus tier", () => {
    expect(effortLevels(capabilitiesFor("claude-opus-4-8"))).toContain("max");
    expect(effortLevels(capabilitiesFor("claude-sonnet-4-6"))).not.toContain("max");
  });
  it("clamps an out-of-range effort to high", () => {
    expect(clampEffort(capabilitiesFor("claude-sonnet-4-6"), "max")).toBe("high");
    expect(clampEffort(capabilitiesFor("claude-opus-4-8"), "xhigh")).toBe("xhigh");
  });
});
