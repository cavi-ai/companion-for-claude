import { describe, expect, it } from "vitest";
import { currentDomainOf, resolveUnresolvedWithCurrentFolder } from "../../src/sources/organize";

describe("currentDomainOf", () => {
  it("returns the relative subfolder for a clip already filed under the inbox", () => {
    expect(currentDomainOf("Clippings/ai-agents/x.md", "Clippings")).toBe("ai-agents");
  });

  it("returns undefined for a clip directly in the inbox root", () => {
    expect(currentDomainOf("Clippings/x.md", "Clippings")).toBeUndefined();
  });

  it("returns the full relative path for a nested subfolder", () => {
    expect(currentDomainOf("Clippings/research/continuity/x.md", "Clippings")).toBe("research/continuity");
  });

  it("tolerates a trailing slash on the inbox folder", () => {
    expect(currentDomainOf("Clippings/ai-agents/x.md", "Clippings/")).toBe("ai-agents");
  });
});

describe("resolveUnresolvedWithCurrentFolder", () => {
  it("proposes the current folder for an unresolved subfolder clip", () => {
    const currentDomains = new Map([["Clippings/ai-agents/x.md", "ai-agents"]]);
    const { proposals, skipped } = resolveUnresolvedWithCurrentFolder(["Clippings/ai-agents/x.md"], currentDomains);
    expect(proposals).toEqual([{ path: "Clippings/ai-agents/x.md", domain: "ai-agents" }]);
    expect(skipped).toEqual([]);
  });

  it("skips a root-level unresolved clip instead of proposing anything", () => {
    const { proposals, skipped } = resolveUnresolvedWithCurrentFolder(["Clippings/root.md"], new Map());
    expect(proposals).toEqual([]);
    expect(skipped).toEqual(["Clippings/root.md"]);
  });

  it("handles a mix of subfolder and root-level unresolved clips", () => {
    const currentDomains = new Map([["Clippings/ai-agents/x.md", "ai-agents"]]);
    const { proposals, skipped } = resolveUnresolvedWithCurrentFolder(
      ["Clippings/ai-agents/x.md", "Clippings/root.md"],
      currentDomains,
    );
    expect(proposals).toEqual([{ path: "Clippings/ai-agents/x.md", domain: "ai-agents" }]);
    expect(skipped).toEqual(["Clippings/root.md"]);
  });
});
