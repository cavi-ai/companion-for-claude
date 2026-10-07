import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TypeProposal } from "../../src/optimize/typeScan";
import {
  createTypeWeaveState,
  evidenceText,
  removeRow,
  rowDescription,
  selectedTypes,
  setRowType,
  toggleRow,
} from "../../src/view/typeWeaveState";

const proposal = (path: string, type: string, over: Partial<TypeProposal> = {}): TypeProposal => ({
  path,
  type,
  evidence: [{ kind: "folder", text: "folder: 3 of 3 typed notes in P/ are project" }],
  checked: true,
  issues: [],
  check: (t) => (t === "person" ? ["'url' is not declared on type 'person'"] : []),
  mtime: 1,
  ...over,
});

const report = (proposals: TypeProposal[]) => ({ proposals, proposable: ["person", "project"], noProposal: 2, notShown: 1 });

describe("typeWeaveState", () => {
  it("starts rows with the scan's checked flag and carries the counts", () => {
    const state = createTypeWeaveState(report([proposal("a.md", "project"), proposal("b.md", "project", { checked: false, issues: ["x"] })]));
    expect(state.rows.map((r) => [r.path, r.type, r.checked])).toEqual([["a.md", "project", true], ["b.md", "project", false]]);
    expect(state).toMatchObject({ noProposal: 2, notShown: 1, proposable: ["person", "project"] });
  });

  it("selectedTypes returns checked rows with their current type, in order", () => {
    let state = createTypeWeaveState(report([proposal("a.md", "project"), proposal("Café 🧠.md", "project", { checked: false })]));
    state = toggleRow(state, "Café 🧠.md", true);
    state = setRowType(state, "a.md", "person");
    expect(selectedTypes(state)).toEqual([{ path: "a.md", type: "person" }, { path: "Café 🧠.md", type: "project" }]);
    state = toggleRow(state, "a.md", false);
    expect(selectedTypes(state)).toEqual([{ path: "Café 🧠.md", type: "project" }]);
  });

  it("changing the type recomputes the issues and does not re-apply the checked default", () => {
    let state = createTypeWeaveState(report([proposal("a.md", "project")]));
    state = setRowType(state, "a.md", "person");
    expect(state.rows[0]).toMatchObject({ type: "person", checked: true, issues: ["'url' is not declared on type 'person'"] });
    state = toggleRow(state, "a.md", false);
    state = setRowType(state, "a.md", "project");
    expect(state.rows[0]).toMatchObject({ type: "project", checked: false, issues: [] });
  });

  it("refuses a type outside the proposable list, so the dropdown cannot leak a hidden type", () => {
    const state = createTypeWeaveState(report([proposal("a.md", "project")]));
    for (const bad of ["entity", "claim", "Project", "", "ghost"]) expect(setRowType(state, "a.md", bad)).toBe(state);
  });

  it("removeRow drops one row only", () => {
    const state = removeRow(createTypeWeaveState(report([proposal("a.md", "project"), proposal("b.md", "project")])), "a.md");
    expect(state.rows.map((r) => r.path)).toEqual(["b.md"]);
  });

  it("a rescan keeps manual checks and type choices while the proposal is unchanged, and resets a changed proposal", () => {
    let state = createTypeWeaveState(report([proposal("a.md", "project"), proposal("b.md", "project")]));
    state = setRowType(toggleRow(state, "a.md", false), "a.md", "person");
    const next = createTypeWeaveState(report([proposal("a.md", "project"), proposal("b.md", "person", { checked: false }), proposal("c.md", "project")]), state);
    expect(next.rows[0]).toMatchObject({ path: "a.md", type: "person", checked: false });
    expect(next.rows[1]).toMatchObject({ path: "b.md", type: "person", checked: false, proposed: "person" });
    expect(next.rows[2]).toMatchObject({ path: "c.md", checked: true });
  });

  it("a rescan resets a row whose chosen type left the proposable list to its proposed type, recomputing checked and issues", () => {
    let state = createTypeWeaveState(report([proposal("a.md", "project")]));
    state = toggleRow(setRowType(state, "a.md", "person"), "a.md", false);
    const next = createTypeWeaveState(
      { ...report([proposal("a.md", "project", { checked: false, issues: ["missing required property 'status'"] })]), proposable: ["project"] },
      state,
    );
    expect(next.rows[0]).toMatchObject({ type: "project", checked: false, issues: ["missing required property 'status'"] });
    const again = createTypeWeaveState({ ...report([proposal("a.md", "project")]), proposable: ["project"] }, state);
    expect(again.rows[0]).toMatchObject({ type: "project", checked: true, issues: [] });
    expect(selectedTypes(again)).toEqual([{ path: "a.md", type: "project" }]);
  });

  it("selectedTypes never yields a type outside the proposable list", () => {
    const state = createTypeWeaveState(report([proposal("a.md", "project")]));
    const stale = { ...state, proposable: ["person"] };
    expect(selectedTypes(stale)).toEqual([]);
  });

  it("describes evidence and the conformance line", () => {
    expect(evidenceText({ kind: "model", model: "qwen3" })).toBe("model: qwen3");
    expect(evidenceText({ kind: "tag", text: "tag: #project" })).toBe("tag: #project");
    const row = createTypeWeaveState(report([proposal("a.md", "project", { evidence: [{ kind: "folder", text: "F" }, { kind: "tag", text: "T" }], issues: ["i1", "i2"] })])).rows[0]!;
    expect(rowDescription(row)).toBe("F · T\nadds 2 issues: i1; i2");
  });
});

describe("pure type weave modules", () => {
  it("typeWeaveState never imports obsidian", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/view/typeWeaveState.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']obsidian["']/);
  });
});
