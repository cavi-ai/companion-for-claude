import { conform } from "../ontology/conform";
import { ROOT_TYPE, type ResolvedType } from "../ontology/types";
import { PLUGIN_NOTE_TYPES } from "../ontology/pluginTypes";
import { tagId } from "../tags/vocabulary";
import { OPTIMIZE_OUTPUT_ROOT } from "./mergePlan";
import type { StoredTypeVerdict } from "./state";

export const MAX_TYPE_ROWS = 100;
export const FOLDER_MIN_TYPED = 3;
export const FOLDER_MIN_SHARE = 0.8;
export const MAX_CONFORMANCE_LISTED = 3;

export interface TypeRegistry {
  resolve(name: string): ResolvedType | undefined;
  resolved(): ReadonlyMap<string, ResolvedType>;
}

export interface TypeScanNote {
  path: string;
  mtime: number;
  /** The metadata-cache frontmatter; absent when the note has none. */
  frontmatter: Record<string, unknown> | undefined;
  /** Frontmatter and inline tags as written. */
  tags: string[];
}

export type TypeEvidence =
  | { kind: "folder"; text: string }
  | { kind: "tag"; text: string }
  | { kind: "model"; model: string };

export interface TypeProposal {
  path: string;
  type: string;
  evidence: TypeEvidence[];
  /** Starts checked only when the type raises no conformance issue. */
  checked: boolean;
  /** Conformance messages for `type` on this note's current frontmatter. */
  issues: string[];
  /** Conformance messages if the row's type were `type`; used after a dropdown change. */
  check: (type: string) => string[];
  mtime: number;
}

export interface TypePending {
  path: string;
  mtime: number;
}

export interface TypeScanInput {
  notes: TypeScanNote[];
  registry: TypeRegistry | null;
  /** Normalized, without a trailing slash; empty when there is none. */
  ontologyFolder: string;
  dismissed: ReadonlySet<string>;
  verdicts: Readonly<Record<string, StoredTypeVerdict>>;
}

export type TypeScanStatus = "no-registry" | "no-types" | "ok";

export interface TypeScanReport {
  status: TypeScanStatus;
  proposable: string[];
  /** Untyped, non-excluded, non-dismissed notes. */
  candidates: number;
  /** Deterministic rows first, then model rows, each newest first; at most MAX_TYPE_ROWS. */
  proposals: TypeProposal[];
  /** Proposals beyond MAX_TYPE_ROWS. */
  notShown: number;
  /** Candidates with no proposal (includes stored "no fitting type" verdicts). */
  noProposal: number;
  /** Candidates the model may be asked about, newest first. */
  pending: TypePending[];
}

/** Any `type` value other than absent or null is the user's; only those two are candidates. */
export const isTyped = (frontmatter: Record<string, unknown> | undefined): boolean => frontmatter?.type !== undefined && frontmatter.type !== null;

export function proposableTypes(registry: TypeRegistry | null): string[] {
  if (!registry) return [];
  return [...registry.resolved().keys()]
    .filter((name) => name !== ROOT_TYPE && !PLUGIN_NOTE_TYPES.has(name))
    .sort((a, b) => a.localeCompare(b));
}

/** Identifies the proposable list a "no fitting type" verdict was judged against. */
export const typesKeyOf = (proposable: readonly string[]): string => proposable.join(",");

export function isExcludedPath(path: string, ontologyFolder: string): boolean {
  return (ontologyFolder !== "" && path.startsWith(`${ontologyFolder}/`)) || path.startsWith(`${OPTIMIZE_OUTPUT_ROOT}/`);
}

const folderOf = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
};

/** Conformance messages for `frontmatter` carrying `type`; unknown type reports one issue. */
export function typeIssues(frontmatter: Record<string, unknown> | undefined, type: string, registry: TypeRegistry): string[] {
  return conform({ ...(frontmatter ?? {}), type }, registry.resolve(type), () => undefined).issues.map((i) => i.message);
}

export function conformanceLine(issues: readonly string[]): string {
  if (issues.length === 0) return "";
  const listed = issues.slice(0, MAX_CONFORMANCE_LISTED).join("; ");
  const more = issues.length > MAX_CONFORMANCE_LISTED ? `; +${issues.length - MAX_CONFORMANCE_LISTED} more` : "";
  return `adds ${issues.length} ${issues.length === 1 ? "issue" : "issues"}: ${listed}${more}`;
}

function folderEvidence(
  note: TypeScanNote,
  typedByFolder: ReadonlyMap<string, string[]>,
): { type: string; text: string } | null {
  const folder = folderOf(note.path);
  const types = typedByFolder.get(folder) ?? [];
  if (types.length < FOLDER_MIN_TYPED) return null;
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const [top, topCount] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] as [string, number];
  if (topCount / types.length < FOLDER_MIN_SHARE) return null;
  return { type: top, text: `folder: ${topCount} of ${types.length} typed notes in ${folder === "" ? "the vault root" : `${folder}/`} are ${top}` };
}

function tagEvidence(note: TypeScanNote, byTagId: ReadonlyMap<string, string>): { type: string; text: string } | null {
  const hits = new Map<string, string>();
  for (const raw of note.tags) {
    const id = tagId(raw);
    const direct = byTagId.get(id);
    const plural = id.endsWith("s") ? byTagId.get(id.slice(0, -1)) : undefined;
    const type = direct ?? plural;
    if (type !== undefined && !hits.has(type)) hits.set(type, `tag: #${id}`);
  }
  if (hits.size !== 1) return null;
  const [type, text] = [...hits][0] as [string, string];
  return { type, text };
}

const newestFirst = (a: { mtime: number; path: string }, b: { mtime: number; path: string }): number =>
  b.mtime - a.mtime || a.path.localeCompare(b.path);

export function verdictIsValid(
  verdict: StoredTypeVerdict | undefined,
  mtime: number,
  proposable: ReadonlySet<string>,
  typesKey: string,
): verdict is StoredTypeVerdict {
  if (!verdict || verdict.mtime !== mtime) return false;
  return verdict.type === null ? verdict.types === typesKey : proposable.has(verdict.type);
}

export function scanUntyped(input: TypeScanInput): TypeScanReport {
  const empty = (status: TypeScanStatus): TypeScanReport => ({ status, proposable: [], candidates: 0, proposals: [], notShown: 0, noProposal: 0, pending: [] });
  const { registry } = input;
  if (!registry) return empty("no-registry");
  const proposable = proposableTypes(registry);
  if (proposable.length === 0) return empty("no-types");
  const proposableSet = new Set(proposable);
  const typesKey = typesKeyOf(proposable);

  const typedByFolder = new Map<string, string[]>();
  for (const n of input.notes) {
    const type = n.frontmatter?.type;
    if (typeof type !== "string" || !proposableSet.has(type) || isExcludedPath(n.path, input.ontologyFolder)) continue;
    const folder = folderOf(n.path);
    typedByFolder.set(folder, [...(typedByFolder.get(folder) ?? []), type]);
  }
  const byTagId = new Map<string, string>();
  for (const name of proposable) byTagId.set(tagId(name), name);

  const candidates = input.notes.filter((n) => !isTyped(n.frontmatter) && !isExcludedPath(n.path, input.ontologyFolder) && !input.dismissed.has(n.path));
  const rowFor = (note: TypeScanNote, type: string, evidence: TypeEvidence[]): TypeProposal => {
    const check = (t: string): string[] => typeIssues(note.frontmatter, t, registry);
    const issues = check(type);
    return { path: note.path, type, evidence, checked: issues.length === 0, issues, check, mtime: note.mtime };
  };

  const deterministic: TypeProposal[] = [];
  const modelRows: TypeProposal[] = [];
  const pending: TypePending[] = [];
  for (const note of candidates) {
    const folder = folderEvidence(note, typedByFolder);
    const tag = tagEvidence(note, byTagId);
    if (folder && tag && folder.type !== tag.type) {
      pending.push({ path: note.path, mtime: note.mtime });
      continue;
    }
    const winner = folder ?? tag;
    if (winner) {
      const evidence: TypeEvidence[] = [];
      if (folder) evidence.push({ kind: "folder", text: folder.text });
      if (tag) evidence.push({ kind: "tag", text: tag.text });
      deterministic.push(rowFor(note, winner.type, evidence));
      continue;
    }
    const verdict = input.verdicts[note.path];
    if (verdictIsValid(verdict, note.mtime, proposableSet, typesKey)) {
      if (verdict.type !== null) modelRows.push(rowFor(note, verdict.type, [{ kind: "model", model: verdict.model }]));
      continue;
    }
    pending.push({ path: note.path, mtime: note.mtime });
  }
  deterministic.sort(newestFirst);
  modelRows.sort(newestFirst);
  pending.sort(newestFirst);
  const all = [...deterministic, ...modelRows];
  return {
    status: "ok",
    proposable,
    candidates: candidates.length,
    proposals: all.slice(0, MAX_TYPE_ROWS),
    notShown: Math.max(0, all.length - MAX_TYPE_ROWS),
    noProposal: candidates.length - all.length,
    pending,
  };
}
