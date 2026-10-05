import type { LinkProposal, OrphanReview } from "../optimize/linkScan";

export interface LinkWeaveRow {
  proposal: LinkProposal;
  checked: boolean;
}
export interface LinkWeaveViewState {
  rows: LinkWeaveRow[];
  /** Orphans with proposals that did not fit in this review. */
  remaining: number;
}

export function createLinkWeaveState(groups: OrphanReview[], remaining: number): LinkWeaveViewState {
  return { rows: groups.flatMap((g) => g.proposals.map((proposal) => ({ proposal, checked: proposal.checked }))), remaining };
}

export function toggleRow(state: LinkWeaveViewState, id: string, checked: boolean): LinkWeaveViewState {
  return { ...state, rows: state.rows.map((row) => (row.proposal.id === id ? { ...row, checked } : row)) };
}

export function removeRow(state: LinkWeaveViewState, id: string): LinkWeaveViewState {
  return { ...state, rows: state.rows.filter((row) => row.proposal.id !== id) };
}

export function selectedProposals(state: LinkWeaveViewState): LinkProposal[] {
  return state.rows.filter((row) => row.checked).map((row) => row.proposal);
}

export function kindLabel(proposal: LinkProposal): string {
  if (proposal.kind === "inbound") return "mentioned in";
  if (proposal.kind === "outbound") return "mentions";
  return `related ${(proposal.score ?? 0).toFixed(2)}`;
}
