import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { planEdits } from "../../src/edit/diff";
import { createSession, decisions } from "../../src/editor/inlineDiffState";
import { buildResolve, buildResolveAll, closeInlineDiff, inlineDiffField, openInlineDiff } from "../../src/editor/inlineDiffExtension";

const DOC = "# Build plan\n\n- [ ] Create the parser\n- [ ] Wire the interface\n- [ ] Ship it\n";

const session = (doc = DOC) =>
  createSession(
    doc,
    planEdits(doc, [
      { old_str: "Create the parser", new_str: "Create the tokenizer" },
      { old_str: "Ship it", new_str: "Ship it to the store" },
    ]),
    { path: "Build plan.md" },
  );

const open = (doc = DOC) => {
  const base = EditorState.create({ doc, extensions: [inlineDiffField] });
  return base.update({ effects: openInlineDiff.of(session(doc)) }).state;
};

const decorationsOf = (state: EditorState): Array<{ from: number; to: number; kind: "mark" | "widget"; cls: string }> => {
  const out: Array<{ from: number; to: number; kind: "mark" | "widget"; cls: string }> = [];
  for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
    const iter = set.iter();
    while (iter.value) {
      const spec = iter.value.spec as { class?: string; widget?: { text?: string; index?: number } };
      out.push({ from: iter.from, to: iter.to, kind: spec.widget ? "widget" : "mark", cls: spec.class ?? (spec.widget && "text" in spec.widget ? "cc-inline-add" : "cc-inline-bar") });
      iter.next();
    }
  }
  return out;
};

describe("inlineDiffField", () => {
  it("is empty until a session opens", () => {
    const state = EditorState.create({ doc: DOC, extensions: [inlineDiffField] });
    expect(state.field(inlineDiffField)).toBeNull();
    expect(decorationsOf(state)).toEqual([]);
  });

  it("decorates each pending hunk with word-level marks, added-text widgets and a control bar", () => {
    const state = open();
    const decos = decorationsOf(state);
    const dels = decos.filter((d) => d.cls === "cc-inline-del");
    const adds = decos.filter((d) => d.cls === "cc-inline-add");
    const bars = decos.filter((d) => d.cls === "cc-inline-bar");
    expect(dels.map((d) => DOC.slice(d.from, d.to))).toEqual(["parser"]);
    expect(adds).toHaveLength(2);
    expect(bars).toHaveLength(2);
    const [first, second] = state.field(inlineDiffField)!.hunks;
    expect(bars.map((b) => b.from)).toEqual([first!.to, second!.to]);
  });

  it("accepting a hunk replaces its text and re-anchors the later hunk", () => {
    const state = open();
    const before = state.field(inlineDiffField)!;
    const spec = buildResolve(state, 0, "accepted");
    expect(spec).not.toBeNull();
    const next = state.update(spec!).state;
    expect(next.doc.toString()).toContain("- [ ] Create the tokenizer");
    const after = next.field(inlineDiffField)!;
    expect(after.hunks[0]!.status).toBe("accepted");
    const delta = "Create the tokenizer".length - "Create the parser".length;
    expect(after.hunks[1]!.from).toBe(before.hunks[1]!.from + delta);
    expect(next.doc.sliceString(after.hunks[1]!.from, after.hunks[1]!.to)).toBe("- [ ] Ship it");
    expect(decorationsOf(next).filter((d) => d.cls === "cc-inline-bar")).toHaveLength(1);
  });

  it("rejecting a hunk leaves the text alone and removes its decorations", () => {
    const state = open();
    const next = state.update(buildResolve(state, 0, "rejected")!).state;
    expect(next.doc.toString()).toBe(DOC);
    expect(next.field(inlineDiffField)!.hunks[0]!.status).toBe("rejected");
    expect(decorationsOf(next).filter((d) => d.cls === "cc-inline-del")).toHaveLength(0);
  });

  it("downgrades an accept to a reject when the text under the hunk drifted", () => {
    const state = open();
    const h = state.field(inlineDiffField)!.hunks[0]!;
    const drifted = state.update({ changes: { from: h.from + 6, to: h.from + 12, insert: "Make" } }).state;
    const next = drifted.update(buildResolve(drifted, 0, "accepted")!).state;
    expect(next.field(inlineDiffField)!.hunks[0]!.status).toBe("rejected");
    expect(next.doc.toString()).toContain("Make the parser");
  });

  it("resolving everything at once applies every accept in one transaction", () => {
    const state = open();
    const next = state.update(buildResolveAll(state, "accepted")!).state;
    expect(next.doc.toString()).toBe(DOC.replace("Create the parser", "Create the tokenizer").replace("Ship it", "Ship it to the store"));
    expect(decisions(next.field(inlineDiffField)!)).toEqual([true, true]);
    expect(buildResolveAll(next, "accepted")).toBeNull();
  });

  it("closes when the whole document is replaced (file switch)", () => {
    const state = open();
    const next = state.update({ changes: { from: 0, to: state.doc.length, insert: "# Other note\n" } }).state;
    expect(next.field(inlineDiffField)).toBeNull();
  });

  it("closes on the close effect", () => {
    const state = open();
    expect(state.update({ effects: closeInlineDiff.of(null) }).state.field(inlineDiffField)).toBeNull();
  });
});
