import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../../src/edit/diff";
import { findUnlinkedMentions, withLinktext } from "../../src/links/unlinkedMentions";
import { mergeRelated, planLinkWeave, renderLinkRunNote } from "../../src/optimize/linkPlan";
import type { LinkProposal } from "../../src/optimize/linkScan";

function body(kind: "inbound" | "outbound", source: string, content: string, targets: string[], target: string): LinkProposal {
  const candidates = withLinktext(targets.map((t) => ({ path: t, basename: (t.split("/").pop() ?? t).replace(/\.md$/, ""), aliases: [] })));
  const m = findUnlinkedMentions(content, candidates, source).find((x) => x.path === target);
  if (!m) throw new Error(`no mention of ${target}`);
  return { id: `${kind}\u0000${source}\u0000${target}`, kind, orphan: kind === "inbound" ? target : source, source, target, linktext: m.target, mention: m, checked: true };
}

function related(source: string, target: string, linktext: string): LinkProposal {
  return { id: `related\u0000${source}\u0000${target}`, kind: "related", orphan: source, source, target, linktext, score: 0.8, checked: true };
}

const applyAll = (plan: NonNullable<ReturnType<typeof planLinkWeave>[number]["body"]>): string => applyPlan(plan.original, plan.plan, plan.plan.hunks.map(() => true));

describe("planLinkWeave", () => {
  it("builds one plan per edited note from exactly the selected rows", () => {
    const content = "Notes on Café and 🧠 Brain.\n\nCafé again.";
    const targets = ["Café.md", "🧠 Brain.md"];
    const rows = [body("outbound", "a.md", content, targets, "Café.md")];
    const [plan] = planLinkWeave(rows, new Map([["a.md", content]]));
    expect(plan?.path).toBe("a.md");
    expect(plan?.body?.original).toBe(content);
    expect(applyAll(plan!.body!)).toBe("Notes on [[Café]] and 🧠 Brain.\n\nCafé again.");
    expect(plan?.linked.map((p) => p.target)).toEqual(["Café.md"]);
  });

  it("writes the path as link text when the basename is shared by two folders", () => {
    const content = "An Idea here.";
    const targets = ["x/Idea.md", "y/Idea.md"];
    const rows = [body("inbound", "a.md", content, targets, "y/Idea.md")];
    const [plan] = planLinkWeave(rows, new Map([["a.md", content]]));
    expect(applyAll(plan!.body!)).toBe("An [[y/Idea|Idea]] here.");
  });

  it("combines several rows on one note, including two on one line, and digits in names", () => {
    const content = "Plan 9 meets 🧠 Brain on one line.";
    const targets = ["Plan 9.md", "🧠 Brain.md"];
    const rows = [body("outbound", "a.md", content, targets, "🧠 Brain.md"), body("outbound", "a.md", content, targets, "Plan 9.md")];
    const [plan] = planLinkWeave(rows, new Map([["a.md", content]]));
    expect(applyAll(plan!.body!)).toBe("[[Plan 9]] meets [[🧠 Brain]] on one line.");
    expect(plan?.linked).toHaveLength(2);
  });

  it("reports a row that overlaps an earlier one instead of corrupting the text", () => {
    const content = "Big Idea Notes here.";
    const targets = ["Big Idea.md", "Idea Notes.md"];
    const rows = [body("outbound", "a.md", content, targets, "Big Idea.md"), body("outbound", "a.md", content, targets, "Idea Notes.md")];
    const [plan] = planLinkWeave(rows, new Map([["a.md", content]]));
    expect(applyAll(plan!.body!)).toBe("[[Big Idea]] Notes here.");
    expect(plan?.unlinked.map((u) => [u.proposal.target, u.message])).toEqual([["Idea Notes.md", "overlaps another link"]]);
  });

  it("carries related rows to their own note and plans no body edit for them", () => {
    const [plan] = planLinkWeave([related("a.md", "b.md", "b")], new Map());
    expect(plan?.body).toBeNull();
    expect(plan?.related.map((p) => p.linktext)).toEqual(["b"]);
  });

  it("plans nothing for a row that is not in the selection", () => {
    expect(planLinkWeave([], new Map([["a.md", "x"]]))).toEqual([]);
  });

  it("moves every row of a note with more edits than one plan accepts to unlinked and plans nothing for it", () => {
    const names = Array.from({ length: 21 }, (_, i) => `Topic${String(i).padStart(2, "0")}`);
    const content = names.map((n) => `Line about ${n}.`).join("\n\n");
    const targets = names.map((n) => `${n}.md`);
    const rows = [...targets.slice(0, 20).map((t) => body("outbound", "a.md", content, targets.slice(0, 20), t)), body("outbound", "a.md", content, targets.slice(1), targets[20] as string)];
    const [plan] = planLinkWeave(rows, new Map([["a.md", content]]));
    expect(plan?.body).toBeNull();
    expect(plan?.linked).toEqual([]);
    expect(plan?.unlinked).toHaveLength(21);
    expect(plan?.unlinked.every((u) => u.message === "too many edits in one note")).toBe(true);
  });

  it("reports body rows whose scan content is missing", () => {
    const content = "Alpha here.";
    const row = body("outbound", "a.md", content, ["Alpha.md"], "Alpha.md");
    const [plan] = planLinkWeave([row], new Map());
    expect(plan?.body).toBeNull();
    expect(plan?.unlinked).toHaveLength(1);
  });
});

describe("mergeRelated", () => {
  it("creates the list when related is absent, null or blank", () => {
    for (const v of [undefined, null, ""]) expect(mergeRelated(v, ["[[A]]"])).toEqual({ ok: true, value: ["[[A]]"], added: ["[[A]]"] });
  });

  it("turns a string into a list that keeps it first", () => {
    expect(mergeRelated("[[Old]]", ["[[A]]"])).toEqual({ ok: true, value: ["[[Old]]", "[[A]]"], added: ["[[A]]"] });
  });

  it("keeps an existing list in order, including non-string entries", () => {
    const existing = ["[[Z]]", ["nested"], 7, "[[B]]"];
    expect(mergeRelated(existing, ["[[A]]"])).toEqual({ ok: true, value: ["[[Z]]", ["nested"], 7, "[[B]]", "[[A]]"], added: ["[[A]]"] });
    expect(existing).toEqual(["[[Z]]", ["nested"], 7, "[[B]]"]);
  });

  it("dedupes by link target across alias, heading, extension, case and Unicode form", () => {
    const nfd = "[[Café]]";
    const out = mergeRelated(["[[Old|alias]]", "[[Sec#head]]", "[[Note.md]]", nfd], ["[[old]]", "[[Sec]]", "[[note]]", "[[Café]]", "[[New]]", "[[new]]"]);
    expect(out).toEqual({ ok: true, value: ["[[Old|alias]]", "[[Sec#head]]", "[[Note.md]]", nfd, "[[New]]"], added: ["[[New]]"] });
  });

  it("keeps a bare string as a value without letting it swallow the same link", () => {
    expect(mergeRelated("Twin", ["[[Twin]]"])).toEqual({ ok: true, value: ["Twin", "[[Twin]]"], added: ["[[Twin]]"] });
  });

  it("counts the one-element array an unquoted YAML [[Twin]] parses to as the link", () => {
    expect(mergeRelated([["Twin"]], ["[[Twin]]"])).toEqual({ ok: true, value: [["Twin"]], added: [] });
  });

  it("keeps path link text distinct from the bare basename", () => {
    expect(mergeRelated(["[[Idea]]"], ["[[a/Idea]]"])).toMatchObject({ ok: true, added: ["[[a/Idea]]"] });
  });

  it("handles emoji and digit link text", () => {
    expect(mergeRelated("[[🧠 Brain]]", ["[[🧠 Brain]]", "[[2024]]"])).toEqual({ ok: true, value: ["[[🧠 Brain]]", "[[2024]]"], added: ["[[2024]]"] });
  });

  it("refuses an object, number or boolean", () => {
    for (const v of [{ a: 1 }, 5, true]) expect(mergeRelated(v, ["[[A]]"])).toEqual({ ok: false, message: "related is not a list" });
  });
});

describe("pure link weave modules", () => {
  it("never import obsidian", () => {
    for (const rel of ["../../src/optimize/linkScan.ts", "../../src/optimize/linkPlan.ts", "../../src/view/linkWeaveState.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(source, rel).not.toMatch(/from\s+["']obsidian["']/);
    }
  });
});

describe("renderLinkRunNote", () => {
  it("lists every link with paths in code spans and never a wikilink", () => {
    const note = renderLinkRunNote({
      applied: [
        { source: "a.md", target: "Café.md", kind: "outbound" },
        { source: "b/c.md", target: "a.md", kind: "inbound" },
        { source: "a.md", target: "[[x]].md", kind: "related" },
      ],
      conflicts: ["d.md"],
      failed: [{ path: "e.md", message: "related is not a list [[x]]" }],
    }, "2026-10-05T12:00:00.000Z");
    expect(note).not.toContain("[[");
    expect(note).toContain('type: "optimize-run"');
    expect(note).toContain("- `a.md` → `x.md` (related)");
    expect(note).toContain("- `a.md` → `Café.md` (outbound)");
    expect(note).toContain("- `b/c.md` → `a.md` (inbound)");
    expect(note).toContain("- `d.md`");
    expect(note).toContain("- `e.md` — related is not a list x");
  });
});
