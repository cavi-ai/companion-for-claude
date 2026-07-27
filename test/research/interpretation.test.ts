import { describe, it, expect } from "vitest";
import { upsertInterpretation } from "../../src/research/interpretation";

const evidenceNote = [
  "---",
  "type: evidence",
  "---",
  "",
  "# Evidence",
  "",
  "> Participants took 23 minutes to refocus.",
  "",
  "^excerpt",
  "",
].join("\n");

describe("upsertInterpretation", () => {
  it("appends an Interpretation block after the excerpt anchor", () => {
    const out = upsertInterpretation(evidenceNote, "Refocus is costly after interruption.");
    expect(out).toContain("^excerpt\n\nInterpretation: Refocus is costly after interruption.\n");
    expect(out).toContain("> Participants took 23 minutes to refocus.");
  });

  it("replaces an existing Interpretation block without touching the rest", () => {
    const withInterp = `${evidenceNote}\nInterpretation: Old reading.\n`;
    const out = upsertInterpretation(withInterp, "New reading.");
    expect(out).toContain("Interpretation: New reading.");
    expect(out).not.toContain("Old reading.");
    expect(out.match(/Interpretation:/g)).toHaveLength(1);
  });

  it("replaces a multi-line Interpretation block up to the next heading", () => {
    const withInterp = `${evidenceNote}\nInterpretation: Line one\nline two\n\n## Notes\nkeep me\n`;
    const out = upsertInterpretation(withInterp, "Condensed.");
    expect(out).toContain("Interpretation: Condensed.");
    expect(out).toContain("## Notes\nkeep me");
    expect(out).not.toContain("line two");
  });

  it("trims and rejects empty interpretations", () => {
    expect(() => upsertInterpretation(evidenceNote, "   ")).toThrow(/must not be empty/);
  });
});
