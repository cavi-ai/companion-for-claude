import { describe, it, expect } from "vitest";
import { renderLimitationsBlock, upsertLimitations } from "../../src/research/limitations";

describe("upsertLimitations", () => {
  it("writes dollar sequences literally when replacing an existing block", () => {
    const note = `# Claim\n\n## Proposition\nX.\n\n${renderLimitationsBlock(["old"])}\n`;
    const out = upsertLimitations(note, ["Only $$5 budgets", "Excludes $& cohorts"]);
    expect(out).toContain("> - Only $$5 budgets\n> - Excludes $& cohorts");
    expect(out).not.toContain("> - old");
  });
});
