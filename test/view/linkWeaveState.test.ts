import { describe, expect, it } from "vitest";
import type { LinkProposal, OrphanReview } from "../../src/optimize/linkScan";
import { createLinkWeaveState, kindLabel, removeRow, selectedProposals, toggleRow } from "../../src/view/linkWeaveState";

const p = (kind: LinkProposal["kind"], source: string, target: string, checked: boolean, score?: number): LinkProposal => ({
  id: `${kind}\u0000${source}\u0000${target}`, kind, orphan: kind === "inbound" ? target : source, source, target, linktext: target, checked, ...(score !== undefined ? { score } : {}),
});
const groups: OrphanReview[] = [
  { path: "o.md", proposals: [p("outbound", "o.md", "a.md", true), p("related", "o.md", "b.md", false, 0.8249)] },
  { path: "q.md", proposals: [p("inbound", "n.md", "q.md", true)] },
];

describe("link weave view state", () => {
  it("flattens groups in order and starts with the proposal's own check", () => {
    const state = createLinkWeaveState(groups, 4);
    expect(state.rows.map((r) => [r.proposal.target, r.checked])).toEqual([["a.md", true], ["b.md", false], ["q.md", true]]);
    expect(state.remaining).toBe(4);
  });

  it("selects exactly the checked rows", () => {
    const state = toggleRow(createLinkWeaveState(groups, 0), "related\u0000o.md\u0000b.md", true);
    expect(selectedProposals(state).map((x) => x.target)).toEqual(["a.md", "b.md", "q.md"]);
    expect(selectedProposals(toggleRow(state, "outbound\u0000o.md\u0000a.md", false)).map((x) => x.target)).toEqual(["b.md", "q.md"]);
  });

  it("removes a dismissed row and keeps the others' checks", () => {
    const state = removeRow(toggleRow(createLinkWeaveState(groups, 0), "related\u0000o.md\u0000b.md", true), "outbound\u0000o.md\u0000a.md");
    expect(state.rows.map((r) => [r.proposal.target, r.checked])).toEqual([["b.md", true], ["q.md", true]]);
  });

  it("labels each kind", () => {
    expect(kindLabel(groups[1]!.proposals[0]!)).toBe("mentioned in");
    expect(kindLabel(groups[0]!.proposals[0]!)).toBe("mentions");
    expect(kindLabel(groups[0]!.proposals[1]!)).toBe("related 0.82");
  });
});
