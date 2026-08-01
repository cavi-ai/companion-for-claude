import { describe, it, expect } from "vitest";
import { parseLintResponse, lintMaxTokens, buildLintUser } from "../src/enrich/noteEnrich";

describe("parseLintResponse", () => {
  const original = "# Title\n\nSome note body with a typo.\n";

  it("returns cleaned text that differs from the original", () => {
    expect(parseLintResponse("# Title\n\nSome note body without a typo.", original)).toBe("# Title\n\nSome note body without a typo.\n");
  });

  it("strips a wrapping code fence", () => {
    expect(parseLintResponse("```markdown\n# Title\n\nFixed body.\n```", original)).toBe("# Title\n\nFixed body.\n");
  });

  it("returns null for an unchanged reply (nothing to review)", () => {
    expect(parseLintResponse(original, original)).toBeNull();
  });

  it("returns null for empty replies", () => {
    expect(parseLintResponse("   ", original)).toBeNull();
  });

  it("returns null for suspiciously short replies (content likely dropped)", () => {
    expect(parseLintResponse("# Title", original)).toBeNull();
  });

  it("preserves the original's no-trailing-newline convention", () => {
    expect(parseLintResponse("fixed body", "typo body")).toBe("fixed body");
  });
});

describe("lint helpers", () => {
  it("scales max tokens with content length within the cap", () => {
    expect(lintMaxTokens("x".repeat(300))).toBe(1124);
    expect(lintMaxTokens("x".repeat(60000))).toBe(16000);
  });

  it("embeds the note in the user prompt", () => {
    expect(buildLintUser("hello")).toBe("NOTE:\n\nhello");
  });
});
