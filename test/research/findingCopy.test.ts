import { describe, expect, it } from "vitest";
import { challengedClaimCopy, findingCopy, type FindingCode } from "../../src/research/findingCopy";

const CODES: FindingCode[] = ["stale-evidence", "missing-locator", "unreviewed-evidence", "unreviewed-claim", "unsupported-claim", "rejected-claim", "broken-reference", "invalid-record", "unverifiable-source", "unused-evidence"];

describe("findingCopy", () => {
  it("names the item and never leaks codes or internal words", () => {
    for (const code of CODES) {
      const { label, reason } = findingCopy(code, "Thing");
      expect(label).toContain("Thing");
      expect(`${label} ${reason}`).not.toMatch(new RegExp(`${code}|fingerprint|frontmatter|locator|record`, "i"));
    }
  });
  it("matches the agreed wording", () => {
    expect(findingCopy("stale-evidence", "X")).toEqual({ label: "Re-check X", reason: "The source changed since you checked this passage. Confirm it still says the same thing." });
    expect(findingCopy("missing-locator", "X").label).toBe("Say where X is");
    expect(findingCopy("unused-evidence", "X").label).toBe("X isn't used yet");
  });
  it("pluralizes the challenged-claim reason", () => {
    expect(challengedClaimCopy("C", 1).reason).toBe("1 passage pushes back on this claim. Note what it doesn't cover.");
    expect(challengedClaimCopy("C", 2).reason).toBe("2 passages push back on this claim. Note what it doesn't cover.");
  });
});
