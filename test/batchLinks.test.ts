import { describe, expect, it } from "vitest";
import { applyBatchLinkPlans, planBatchLinks } from "../src/links/batch";
import type { BatchLinkEntry } from "../src/links/batch";
import type { LinkCandidate } from "../src/links/unlinkedMentions";

const candidates: LinkCandidate[] = [
  { path: "Projects/Atlas.md", basename: "Project Atlas", aliases: [] },
  { path: "People/Ada.md", basename: "Ada Lovelace", aliases: [] },
];

describe("planBatchLinks", () => {
  it("catches a regression that retains notes without linkable prose", () => {
    const entries: BatchLinkEntry[] = [
      { path: "Notes/zeta.md", basename: "Zeta", content: "Project Atlas is ready.\n" },
      { path: "Notes/empty.md", basename: "Empty", content: "Nothing to link here.\n" },
      { path: "Notes/alpha.md", basename: "Alpha", content: "Ada Lovelace reviewed Project Atlas.\n" },
    ];

    const plans = planBatchLinks(entries, candidates);

    expect(plans.map((plan) => plan.path)).toEqual(["Notes/alpha.md", "Notes/zeta.md"]);
    expect(plans.map((plan) => plan.basename)).toEqual(["Alpha", "Zeta"]);
    expect(plans[0]!.original).toBe("Ada Lovelace reviewed Project Atlas.\n");
    expect(plans[0]!.plan.hunks).toHaveLength(1);
    expect(plans[1]!.plan.hunks).toHaveLength(1);
  });

});

describe("applyBatchLinkPlans", () => {
  const plans = () => planBatchLinks([
    { path: "Notes/alpha.md", basename: "Alpha", content: "Project Atlas leads.\n" },
    { path: "Notes/beta.md", basename: "Beta", content: "Ada Lovelace follows.\n" },
  ], candidates);

  it("catches a regression that applies selected hunks to only the first file", async () => {
    const files = new Map([
      ["Notes/alpha.md", "Project Atlas leads.\n"],
      ["Notes/beta.md", "Ada Lovelace follows.\n"],
    ]);

    const result = await applyBatchLinkPlans(plans(), [[true], [true]], {
      process: async (path, transform) => { files.set(path, transform(files.get(path)!)); },
    });

    expect(result).toEqual({ appliedFiles: 2, appliedHunks: 2, conflicts: [], failures: [] });
    expect(files.get("Notes/alpha.md")).toBe("[[Project Atlas]] leads.\n");
    expect(files.get("Notes/beta.md")).toBe("[[Ada Lovelace]] follows.\n");
  });

  it("catches a regression that lets one current-content conflict block another file", async () => {
    const files = new Map([
      ["Notes/alpha.md", "Project Atlas changed.\n"],
      ["Notes/beta.md", "Ada Lovelace follows.\n"],
    ]);

    const result = await applyBatchLinkPlans(plans(), [[true], [true]], {
      process: async (path, transform) => { files.set(path, transform(files.get(path)!)); },
    });

    expect(result).toEqual({ appliedFiles: 1, appliedHunks: 1, conflicts: ["Notes/alpha.md"], failures: [] });
    expect(files.get("Notes/alpha.md")).toBe("Project Atlas changed.\n");
    expect(files.get("Notes/beta.md")).toBe("[[Ada Lovelace]] follows.\n");
  });

  it("catches a regression that overwrites a mutation visible only inside the atomic transform", async () => {
    let current = "Project Atlas changed after the review opened.\n";

    const result = await applyBatchLinkPlans(plans().slice(0, 1), [[true]], {
      // The storage transform receives the authoritative value held under its
      // write lock, after any state used while the review was being prepared.
      process: async (_path: string, transform: (content: string) => string) => {
        current = transform(current);
      },
    });

    expect(result).toEqual({ appliedFiles: 0, appliedHunks: 0, conflicts: ["Notes/alpha.md"], failures: [] });
    expect(current).toBe("Project Atlas changed after the review opened.\n");
  });

  it("catches a regression that lets one write rejection prevent other selected files from applying", async () => {
    const files = new Map([
      ["Notes/alpha.md", "Project Atlas leads.\n"],
      ["Notes/beta.md", "Ada Lovelace follows.\n"],
    ]);

    const result = await applyBatchLinkPlans(plans(), [[true], [true]], {
      process: async (path, transform) => {
        const content = transform(files.get(path)!);
        if (path === "Notes/alpha.md") throw new Error("disk full");
        files.set(path, content);
      },
    });

    expect(result).toEqual({
      appliedFiles: 1,
      appliedHunks: 1,
      conflicts: [],
      failures: [{ path: "Notes/alpha.md", message: "disk full" }],
    });
    expect(files.get("Notes/alpha.md")).toBe("Project Atlas leads.\n");
    expect(files.get("Notes/beta.md")).toBe("[[Ada Lovelace]] follows.\n");
  });

  it("catches a regression that reads or writes a file with no selected hunks", async () => {
    const files = new Map([
      ["Notes/alpha.md", "Project Atlas leads.\n"],
      ["Notes/beta.md", "Ada Lovelace follows.\n"],
    ]);

    const result = await applyBatchLinkPlans(plans(), [[false], [true]], {
      process: async (path, transform) => {
        if (path === "Notes/alpha.md") throw new Error("unselected file should not be processed");
        files.set(path, transform(files.get(path)!));
      },
    });

    expect(result).toEqual({ appliedFiles: 1, appliedHunks: 1, conflicts: [], failures: [] });
    expect(files.get("Notes/alpha.md")).toBe("Project Atlas leads.\n");
  });
});
