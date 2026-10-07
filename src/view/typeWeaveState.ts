import { conformanceLine, type TypeEvidence, type TypeProposal, type TypeScanReport } from "../optimize/typeScan";

export interface TypeWeaveRow {
  path: string;
  /** The type currently chosen in the row's dropdown. */
  type: string;
  /** The type the scan proposed; a rescan keeps the row only while this is unchanged. */
  proposed: string;
  evidence: TypeEvidence[];
  checked: boolean;
  issues: string[];
  check: (type: string) => string[];
}

export interface TypeWeaveViewState {
  rows: TypeWeaveRow[];
  proposable: string[];
  /** Untyped notes with no proposal. */
  noProposal: number;
  /** Proposals that did not fit in this review. */
  notShown: number;
}

function rowFor(p: TypeProposal): TypeWeaveRow {
  return { path: p.path, type: p.type, proposed: p.type, evidence: p.evidence, checked: p.checked, issues: p.issues, check: p.check };
}

/** A row the user already saw keeps its manual check and type choice while the scan still proposes the same type. */
export function createTypeWeaveState(
  report: Pick<TypeScanReport, "proposals" | "proposable" | "noProposal" | "notShown">,
  previous?: TypeWeaveViewState,
): TypeWeaveViewState {
  const before = new Map((previous?.rows ?? []).map((row) => [row.path, row]));
  return {
    rows: report.proposals.map((p) => {
      const prior = before.get(p.path);
      if (!prior || prior.proposed !== p.type) return rowFor(p);
      if (!report.proposable.includes(prior.type)) return rowFor(p);
      return { ...prior, evidence: p.evidence };
    }),
    proposable: report.proposable,
    noProposal: report.noProposal,
    notShown: report.notShown,
  };
}

const mapRow = (state: TypeWeaveViewState, path: string, fn: (row: TypeWeaveRow) => TypeWeaveRow): TypeWeaveViewState => ({
  ...state,
  rows: state.rows.map((row) => (row.path === path ? fn(row) : row)),
});

export function toggleRow(state: TypeWeaveViewState, path: string, checked: boolean): TypeWeaveViewState {
  return mapRow(state, path, (row) => ({ ...row, checked }));
}

/** The checked default is not re-applied; only the conformance issues follow the new type. */
export function setRowType(state: TypeWeaveViewState, path: string, type: string): TypeWeaveViewState {
  if (!state.proposable.includes(type)) return state;
  return mapRow(state, path, (row) => ({ ...row, type, issues: row.check(type) }));
}

export function removeRow(state: TypeWeaveViewState, path: string): TypeWeaveViewState {
  return { ...state, rows: state.rows.filter((row) => row.path !== path) };
}

export function selectedTypes(state: TypeWeaveViewState): Array<{ path: string; type: string }> {
  return state.rows.filter((row) => row.checked && state.proposable.includes(row.type)).map((row) => ({ path: row.path, type: row.type }));
}

export function evidenceText(evidence: TypeEvidence): string {
  return evidence.kind === "model" ? `model: ${evidence.model}` : evidence.text;
}

export function rowDescription(row: TypeWeaveRow): string {
  const line = conformanceLine(row.issues);
  const evidence = row.evidence.map(evidenceText).join(" · ");
  return line ? `${evidence}\n${line}` : evidence;
}
