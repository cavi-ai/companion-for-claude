import { planEdits } from "../edit/diff";
import { buildFrontmatter } from "../indexing/frontmatter";
import type { BatchLinkPlan } from "../links/batch";
import { mentionEdits } from "../links/suggest";
import type { LinkProposal } from "./linkScan";

export interface FileLinkPlan {
  path: string;
  /** Null when no selected body row could be planned. */
  body: BatchLinkPlan | null;
  /** Body rows the plan really links; the rest are in `unlinked`. */
  linked: LinkProposal[];
  unlinked: Array<{ proposal: LinkProposal; message: string }>;
  related: LinkProposal[];
}

const MAX_EDITS_MESSAGE = "too many edits in one note";
const basename = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/** Group the checked rows into one plan per edited note. Only checked rows reach a plan. */
export function planLinkWeave(selected: LinkProposal[], contents: ReadonlyMap<string, string>): FileLinkPlan[] {
  const bySource = new Map<string, LinkProposal[]>();
  for (const p of selected) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
  const plans: FileLinkPlan[] = [];
  for (const [path, rows] of [...bySource].sort((a, b) => a[0].localeCompare(b[0]))) {
    const related = rows.filter((p) => p.kind === "related");
    const bodyRows = rows.filter((p) => p.mention);
    const plan: FileLinkPlan = { path, body: null, linked: [], unlinked: [], related };
    const original = contents.get(path);
    if (bodyRows.length > 0 && original === undefined) {
      plan.unlinked = bodyRows.map((proposal) => ({ proposal, message: "note content missing from the scan" }));
    } else if (bodyRows.length > 0 && original !== undefined) {
      const realizable: LinkProposal[] = [];
      let guard = -1;
      for (const row of [...bodyRows].sort((a, b) => (a.mention?.start ?? 0) - (b.mention?.start ?? 0))) {
        const m = row.mention!;
        if (m.start < guard) {
          plan.unlinked.push({ proposal: row, message: "overlaps another link" });
        } else if (mentionEdits(original, [m]).length === 0) {
          plan.unlinked.push({ proposal: row, message: "could not be linked uniquely" });
        } else {
          realizable.push(row);
          guard = m.end;
        }
      }
      if (realizable.length > 0) {
        try {
          const edits = mentionEdits(original, realizable.map((r) => r.mention!));
          plan.body = { path, basename: basename(path), original, plan: planEdits(original, edits) };
          plan.linked = realizable;
        } catch {
          plan.unlinked.push(...realizable.map((proposal) => ({ proposal, message: MAX_EDITS_MESSAGE })));
        }
      }
    }
    plans.push(plan);
  }
  return plans;
}

const wikiTarget = (entry: string): string => {
  const m = /^\s*\[\[([^\]|#]*)/.exec(entry);
  return (m ? (m[1] as string) : entry).trim().replace(/\.md$/i, "").normalize("NFC").toLowerCase();
};

export type RelatedMerge = { ok: true; value: unknown[]; added: string[] } | { ok: false; message: string };

/** Append `[[…]]` entries to a `related` value: existing entries stay in order, links already present are not repeated. */
export function mergeRelated(existing: unknown, add: string[]): RelatedMerge {
  let kept: unknown[];
  if (existing === undefined || existing === null || existing === "") kept = [];
  else if (typeof existing === "string") kept = [existing];
  else if (Array.isArray(existing)) kept = [...(existing as unknown[])];
  else return { ok: false, message: "related is not a list" };
  const seen = new Set<string>();
  for (const e of kept) {
    if (typeof e === "string" && e.trimStart().startsWith("[[")) seen.add(wikiTarget(e));
    else if (Array.isArray(e) && e.length === 1 && typeof e[0] === "string") seen.add(wikiTarget(e[0]));
  }
  const added: string[] = [];
  for (const entry of add) {
    const key = wikiTarget(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(entry);
  }
  return { ok: true, value: [...kept, ...added], added };
}

export interface AppliedLink {
  source: string;
  target: string;
  kind: "inbound" | "outbound" | "related";
}

export interface LinkRunNoteInput {
  applied: AppliedLink[];
  conflicts: string[];
  failed: Array<{ path: string; message: string }>;
}

const code = (text: string): string => `\`${text.replace(/`/g, "'").replace(/\[\[|\]\]/g, "")}\``;

/** Paths in code spans only: a wikilink here would link the orphans this run connected. */
export function renderLinkRunNote(input: LinkRunNoteInput, now: string): string {
  const notes = new Set(input.applied.map((l) => l.source));
  const lines = [
    buildFrontmatter({ type: "optimize-run", created: now, links: input.applied.length, notes: notes.size }),
    "",
    "# Link weave",
    "",
  ];
  for (const l of input.applied) lines.push(`- ${code(l.source)} → ${code(l.target)} (${l.kind})`);
  if (input.conflicts.length > 0) {
    lines.push("", "## Changed since the review, not edited", "");
    for (const p of input.conflicts) lines.push(`- ${code(p)}`);
  }
  if (input.failed.length > 0) {
    lines.push("", "## Not linked", "");
    for (const f of input.failed) lines.push(`- ${code(f.path)} — ${f.message.replace(/\[\[|\]\]/g, "")}`);
  }
  return `${lines.join("\n")}\n`;
}
