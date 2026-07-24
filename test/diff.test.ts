import { describe, it, expect } from "vitest";
import { planEdits, applyPlan, type ProposedEdit } from "../src/edit/diff";

describe("applyPlan — drift safety", () => {
  it("rejects the apply when drift makes two accepted hunks resolve to overlapping ranges", () => {
    // Two multi-line edits, well separated (and individually unique) at plan time.
    const original = "PPP\nQQ\nxxxxx\nQQ\nRRR\n";
    const plan = planEdits(original, [
      { old_str: "PPP\nQQ", new_str: "AAA" },
      { old_str: "QQ\nRRR", new_str: "BBB" },
    ]);
    // The note was rewritten during review to "PPP\nQQ\nRRR": both targets are
    // still uniquely locatable but their line regions now overlap on "QQ".
    expect(() => applyPlan("PPP\nQQ\nRRR", plan, [true, true])).toThrow(/overlap/i);
  });
});

const NOTE = `# Weekly Review

Every Friday I review the week: wins, blockers, and what to carry forward.

## Wins
- agent loop tests all green
- caching verified live

## Blockers
- needs a manual acceptance run

## Carry forward
Nothing yet.
`;

const edit = (old_str: string, new_str: string): ProposedEdit => ({ old_str, new_str });

describe("planEdits", () => {
  it("plans a single hunk with context and line number", () => {
    const plan = planEdits(NOTE, [edit("- caching verified live", "- caching verified against the live API")]);
    expect(plan.hunks).toHaveLength(1);
    const h = plan.hunks[0]!;
    expect(h.lineno).toBe(7);
    const kinds = h.lines.map((l) => l.kind);
    expect(kinds).toContain("del");
    expect(kinds).toContain("add");
    expect(kinds.filter((k) => k === "context").length).toBeGreaterThan(0);
    expect(h.lines.find((l) => l.kind === "del")?.text).toBe("- caching verified live");
    expect(h.lines.find((l) => l.kind === "add")?.text).toBe("- caching verified against the live API");
  });

  it("orders multiple hunks by position regardless of edit order", () => {
    const plan = planEdits(NOTE, [
      edit("Nothing yet.", "Ship slice 2."),
      edit("## Wins", "## Wins this week"),
    ]);
    expect(plan.hunks.map((h) => h.lineno)).toEqual([5, 13]);
  });

  it("keeps unchanged shared lines as context in a multi-line replacement (intra-hunk LCS)", () => {
    const plan = planEdits(NOTE, [
      edit(
        "## Blockers\n- needs a manual acceptance run",
        "## Blockers\n- manual acceptance run scheduled for Friday",
      ),
    ]);
    const h = plan.hunks[0]!;
    // "## Blockers" is common to both sides — must not render as del+add churn.
    expect(h.lines.filter((l) => l.text === "## Blockers").map((l) => l.kind)).toEqual(["context"]);
  });

  it("handles an edit at the very start of the file (no leading context)", () => {
    const plan = planEdits(NOTE, [edit("# Weekly Review", "# Weekly Review — 2026-W27")]);
    expect(plan.hunks[0]!.lineno).toBe(1);
    expect(plan.hunks[0]!.lines[0]!.kind).not.toBe("context");
  });

  it("rejects an old_str that is not in the note", () => {
    expect(() => planEdits(NOTE, [edit("no such text", "x")])).toThrow(/not found/i);
  });

  it("rejects an ambiguous old_str", () => {
    expect(() => planEdits(NOTE, [edit("##", "#")])).toThrow(/more than once|ambiguous/i);
  });

  it("rejects overlapping edits", () => {
    expect(() =>
      planEdits(NOTE, [edit("## Wins\n- agent loop tests all green", "x"), edit("- agent loop tests all green\n- caching verified live", "y")]),
    ).toThrow(/overlap/i);
  });

  it("rejects empty input, empty old_str, no-op edits, and >20 edits", () => {
    expect(() => planEdits(NOTE, [])).toThrow(/no edits/i);
    expect(() => planEdits(NOTE, [edit("", "x")])).toThrow(/empty/i);
    expect(() => planEdits(NOTE, [edit("## Wins", "## Wins")])).toThrow(/identical|no-op/i);
    const many = Array.from({ length: 21 }, (_, i) => edit(`missing-${i}`, "x"));
    expect(() => planEdits(NOTE, many)).toThrow(/too many/i);
  });

  it("preserves CRLF content byte-exactly outside the edit", () => {
    const crlf = "alpha\r\nbeta\r\ngamma\r\n";
    const plan = planEdits(crlf, [edit("beta", "BETA")]);
    expect(applyPlan(crlf, plan, [true])).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });
});

describe("applyPlan", () => {
  it("applies all accepted hunks", () => {
    const plan = planEdits(NOTE, [edit("Nothing yet.", "Ship slice 2."), edit("## Wins", "## Wins this week")]);
    const out = applyPlan(NOTE, plan, [true, true]);
    expect(out).toContain("## Wins this week");
    expect(out).toContain("Ship slice 2.");
    expect(out).not.toContain("Nothing yet.");
  });

  it("applies only the accepted subset", () => {
    const plan = planEdits(NOTE, [edit("## Wins", "## Wins this week"), edit("Nothing yet.", "Ship slice 2.")]);
    const out = applyPlan(NOTE, plan, [false, true]);
    expect(out).toContain("## Wins\n"); // first hunk rejected
    expect(out).toContain("Ship slice 2.");
  });

  it("returns the original content when nothing is accepted", () => {
    const plan = planEdits(NOTE, [edit("## Wins", "## Winning")]);
    expect(applyPlan(NOTE, plan, [false])).toBe(NOTE);
  });

  it("earlier accepted hunks do not corrupt later hunk positions", () => {
    const plan = planEdits(NOTE, [
      edit("Every Friday I review the week: wins, blockers, and what to carry forward.", "Weekly review ritual."),
      edit("Nothing yet.", "Ship slice 2."),
    ]);
    const out = applyPlan(NOTE, plan, [true, true]);
    expect(out).toContain("Weekly review ritual.");
    expect(out).toContain("Ship slice 2.");
  });

  it("re-locates a hunk when unrelated text changed the offsets", () => {
    const plan = planEdits(NOTE, [edit("Nothing yet.", "Ship slice 2.")]);
    const drifted = `<!-- banner added while the modal was open -->\n${NOTE}`;
    const out = applyPlan(drifted, plan, [true]);
    expect(out).toContain("Ship slice 2.");
    expect(out.startsWith("<!-- banner")).toBe(true);
  });

  it("throws when the note changed under an accepted hunk", () => {
    const plan = planEdits(NOTE, [edit("Nothing yet.", "Ship slice 2.")]);
    const changed = NOTE.replace("Nothing yet.", "Everything, actually.");
    expect(() => applyPlan(changed, plan, [true])).toThrow(/changed/i);
  });

  it("rejects an accepted[] length mismatch", () => {
    const plan = planEdits(NOTE, [edit("## Wins", "## W")]);
    expect(() => applyPlan(NOTE, plan, [true, false])).toThrow(/length/i);
  });
});
