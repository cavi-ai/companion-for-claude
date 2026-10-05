import { applyBatchLinkPlans } from "../links/batch";
import { renderLinkRunNote, planLinkWeave, type AppliedLink } from "./linkPlan";
import { dismissalKey, type LinkProposal, type LinkScanReport } from "./linkScan";
import { normalizeOptimizeState, type OptimizeState } from "./state";

export interface LinkApplyResult {
  links: number;
  notes: number;
  conflicts: string[];
  failed: Array<{ path: string; message: string }>;
  runNote: string | null;
}

export type RelatedWrite = { ok: true; added: string[] } | { ok: false; message: string };

export interface LinkWeaveDeps {
  scan(dismissed: ReadonlySet<string>, onProgress?: (done: number, total: number) => void): Promise<LinkScanReport>;
  /** `vault.process`: the transform sees the current content. */
  processBody(path: string, transform: (current: string) => string): Promise<void>;
  /** `processFrontMatter` with `mergeRelated`; the `[[…]]` strings it really added. */
  addRelated(path: string, entries: string[]): Promise<RelatedWrite>;
  writeRunNote(content: string, now: string): Promise<string>;
  getState(): OptimizeState;
  setState(next: OptimizeState): Promise<void>;
  now(): string;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function formatLinkApplyNotice(result: LinkApplyResult): string {
  let text = `Added ${count(result.links, "link", "links")} across ${count(result.notes, "note", "notes")}`;
  if (result.conflicts.length > 0) text += `, ${count(result.conflicts.length, "note", "notes")} changed since the review and left alone`;
  if (result.failed.length > 0) text += `, ${count(result.failed.length, "link", "links")} not added`;
  return text;
}

/** The notice for a scan with nothing to review. */
export function formatLinkScanEmptyNotice(report: Pick<LinkScanReport, "orphanCount">): string {
  if (report.orphanCount === 0) return "No orphan notes to connect.";
  return `${count(report.orphanCount, "orphan note", "orphan notes")}, none with a link to propose.`;
}

export class LinkWeaveController {
  constructor(private deps: LinkWeaveDeps) {}

  scan(onProgress?: (done: number, total: number) => void): Promise<LinkScanReport> {
    return this.deps.scan(new Set(this.deps.getState().dismissedLinks ?? []), onProgress);
  }

  async dismiss(proposal: Pick<LinkProposal, "source" | "target">): Promise<void> {
    const state = this.deps.getState();
    await this.deps.setState(normalizeOptimizeState({ ...state, dismissedLinks: [...(state.dismissedLinks ?? []), dismissalKey(proposal.source, proposal.target)] }));
  }

  /** Writes exactly the given rows; nothing else is touched. */
  async apply(selected: LinkProposal[], contents: ReadonlyMap<string, string>): Promise<LinkApplyResult> {
    const plans = planLinkWeave(selected, contents);
    const withBody = plans.flatMap((p) => (p.body ? [{ plan: p, body: p.body }] : []));
    const batch = await applyBatchLinkPlans(
      withBody.map((p) => p.body),
      withBody.map((p) => p.body.plan.hunks.map(() => true)),
      { process: (path, transform) => this.deps.processBody(path, transform) },
    );
    const conflicts = new Set(batch.conflicts);
    const failedBody = new Set(batch.failures.map((f) => f.path));
    const failed: LinkApplyResult["failed"] = [...batch.failures];
    const applied: AppliedLink[] = [];

    for (const plan of plans) {
      for (const u of plan.unlinked) failed.push({ path: plan.path, message: `${u.proposal.target}: ${u.message}` });
      const bodyDone = plan.body !== null && !conflicts.has(plan.path) && !failedBody.has(plan.path);
      if (bodyDone) for (const p of plan.linked) applied.push({ source: p.source, target: p.target, kind: p.kind });
      if (plan.related.length === 0) continue;
      if (conflicts.has(plan.path) || failedBody.has(plan.path)) continue;
      try {
        const write = await this.deps.addRelated(plan.path, plan.related.map((r) => `[[${r.linktext}]]`));
        if (!write.ok) {
          failed.push({ path: plan.path, message: write.message });
          continue;
        }
        const added = new Set(write.added);
        for (const r of plan.related) {
          if (added.has(`[[${r.linktext}]]`)) applied.push({ source: r.source, target: r.target, kind: "related" });
          else failed.push({ path: plan.path, message: `${r.target}: already in related` });
        }
      } catch (error) {
        failed.push({ path: plan.path, message: error instanceof Error ? error.message : String(error) });
      }
    }

    let runNote: string | null = null;
    if (applied.length > 0) {
      const now = this.deps.now();
      try {
        runNote = await this.deps.writeRunNote(renderLinkRunNote({ applied, conflicts: batch.conflicts, failed }, now), now);
      } catch {
        runNote = null;
      }
    }
    return { links: applied.length, notes: new Set(applied.map((l) => l.source)).size, conflicts: batch.conflicts, failed, runNote };
  }
}
