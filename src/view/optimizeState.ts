import type { StoredVerdict } from "../optimize/state";
import type { MergeCandidate, MergeEvidence } from "../optimize/tagScan";

export interface OptimizeRow {
  id: string;
  from: string;
  to: string;
  fromCount: number;
  toCount: number;
  evidence: MergeEvidence[];
  checked: boolean;
  verdict?: StoredVerdict;
}
export interface OptimizeViewState {
  rows: OptimizeRow[];
  /** Pairs with only typo or semantic evidence and no verdict yet; offered only after the model says merge. */
  awaitingModel: number;
}

/** Name-level evidence that two tags are spellings of one tag; typo and semantic evidence are not. */
const SAME_NAME: ReadonlySet<MergeEvidence> = new Set(["separator", "plural", "plural-loose", "token-order", "leaf"]);

/** Offered as a merge only when the names say it is one tag or the model said merge; related tags never are. */
export function isMergeOffer(c: MergeCandidate): boolean {
  if (c.verdict) return c.verdict.verdict === "merge";
  return c.evidence.some((e) => SAME_NAME.has(e));
}

const mapRow = (state: OptimizeViewState, id: string, fn: (row: OptimizeRow) => OptimizeRow): OptimizeViewState => ({
  ...state,
  rows: state.rows.map((row) => (row.id === id ? fn(row) : row)),
});

const sameVerdict = (a?: StoredVerdict, b?: StoredVerdict): boolean =>
  a === b || (!!a && !!b && a.verdict === b.verdict && a.canonical === b.canonical && a.at === b.at);

function rowFor(c: MergeCandidate): OptimizeRow {
  const row: OptimizeRow = {
    id: c.id,
    from: c.from,
    to: c.to,
    fromCount: c.fromCount,
    toCount: c.toCount,
    evidence: [...c.evidence],
    checked: c.evidence.includes("separator") || c.evidence.includes("plural") || c.verdict?.verdict === "merge",
    ...(c.verdict ? { verdict: c.verdict } : {}),
  };
  if (c.verdict?.verdict === "merge" && c.verdict.canonical === c.from) {
    return { ...row, from: c.to, to: c.from, fromCount: c.toCount, toCount: c.fromCount };
  }
  return row;
}

/** A row the user already saw keeps its manual checks and swap unless the model gave it a new verdict. */
export function createOptimizeState(candidates: MergeCandidate[], previous?: OptimizeViewState): OptimizeViewState {
  const before = new Map((previous?.rows ?? []).map((row) => [row.id, row]));
  return {
    rows: candidates.filter(isMergeOffer).map((c) => {
      const prior = before.get(c.id);
      return prior && sameVerdict(prior.verdict, c.verdict) ? prior : rowFor(c);
    }),
    awaitingModel: candidates.filter((c) => !c.verdict && !isMergeOffer(c)).length,
  };
}

export function toggleRow(state: OptimizeViewState, id: string, checked: boolean): OptimizeViewState {
  return mapRow(state, id, (row) => ({ ...row, checked }));
}

export function swapRow(state: OptimizeViewState, id: string): OptimizeViewState {
  return mapRow(state, id, (row) => ({ ...row, from: row.to, to: row.from, fromCount: row.toCount, toCount: row.fromCount }));
}

export function removeRow(state: OptimizeViewState, id: string): OptimizeViewState {
  return { ...state, rows: state.rows.filter((row) => row.id !== id) };
}

export function selectedMerges(state: OptimizeViewState): Array<{ from: string; to: string }> {
  return state.rows.filter((row) => row.checked).map((row) => ({ from: row.from, to: row.to }));
}
