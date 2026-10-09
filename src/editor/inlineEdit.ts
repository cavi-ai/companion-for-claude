// Edit with Claude at the cursor: prompt → one buffered completion → inline review. Pure; IO injected by main.ts.

import { applyPlan, planEdits, type EditPlan } from "../edit/diff";
import { INSERT_SYSTEM, REWRITE_PRESETS, REWRITE_SYSTEM, buildInsertUser, buildRewriteUser, parseInsert, parseRewrite, rewriteMaxTokens } from "../edit/rewrite";
import { createRangeSession, type InlineDiffSession } from "./inlineDiffState";
import type { InlinePromptHandle, InlinePromptOptions } from "./inlinePrompt";

export interface CompleteRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}

export interface ModalRewrite {
  selection: string;
  rewritten: string;
  instruction: string;
  from: number;
  to: number;
}

export interface InlineEditDeps {
  path: string;
  inlineDiffEnabled: boolean;
  openPrompt(opts: InlinePromptOptions): InlinePromptHandle;
  complete(req: CompleteRequest): Promise<string>;
  currentDoc(): string;
  review(session: InlineDiffSession): Promise<boolean[] | null>;
  /** The DiffModal path used when inline diff review is off (selection mode only). */
  reviewModal(rewrite: ModalRewrite): Promise<void>;
  notice(message: string): void;
  begin(label: string): { finish(): void; fail(error: unknown): void };
  failureMessage(error: unknown): string;
}

export type InlineEditOutcome = "skipped" | "closed" | "aborted" | "stale" | "applied" | "rejected" | "modal" | "failed";

export const CHANGED_UNDER_EDIT = "The note changed under the edit; nothing was applied.";
export const INSERT_NEEDS_INLINE_DIFF = "Turn on inline diff review to write at the cursor.";

/** A modal rewrite plan: against the whole note, or against the selection alone and anchored at the editor offsets. */
export interface ModalRewritePlan {
  plan: EditPlan;
  anchor: { start: number; end: number } | null;
  selection: string;
  rewritten: string;
}

export function planModalRewrite(content: string, rewrite: ModalRewrite): ModalRewritePlan {
  const { selection, rewritten } = rewrite;
  try {
    return { plan: planEdits(content, [{ old_str: selection, new_str: rewritten }]), anchor: null, selection, rewritten };
  } catch {
    return { plan: planEdits(selection, [{ old_str: selection, new_str: rewritten }]), anchor: { start: rewrite.from, end: rewrite.to }, selection, rewritten };
  }
}

/** The note with the accepted rewrite, or null when the anchor no longer holds the selection. */
export function applyModalRewrite(current: string, prepared: ModalRewritePlan, accepted: boolean[]): string | null {
  const { anchor, selection, rewritten, plan } = prepared;
  if (!anchor) return applyPlan(current, plan, accepted);
  if (current.slice(anchor.start, anchor.end) !== selection) return null;
  return accepted[0] ? current.slice(0, anchor.start) + rewritten + current.slice(anchor.end) : current;
}

/** Apply inside one vault transform; a stale anchor leaves the note untouched. */
export async function commitModalRewrite(
  process: (transform: (current: string) => string) => Promise<unknown>,
  prepared: ModalRewritePlan,
  accepted: boolean[],
  notice: (message: string) => void,
): Promise<boolean> {
  let stale = false;
  await process((current) => {
    const next = applyModalRewrite(current, prepared, accepted);
    stale = next === null;
    return next ?? current;
  });
  notice(stale ? CHANGED_UNDER_EDIT : "Rewrite applied.");
  return !stale;
}

/** A whitespace-only selection is not a rewrite target, matching runInlineEdit. */
export function inlineEditMenuTitle(selection: string): string {
  return selection.trim().length > 0 ? "Rewrite with Claude…" : "Write with Claude at cursor…";
}

export async function runInlineEdit(target: { doc: string; from: number; to: number }, deps: InlineEditDeps): Promise<InlineEditOutcome> {
  const mode = target.from === target.to ? "insert" : "rewrite";
  const selection = target.doc.slice(target.from, target.to);
  if (mode === "rewrite" && selection.trim().length === 0) {
    deps.notice("Select some text to rewrite, or place the cursor to write.");
    return "skipped";
  }
  if (mode === "insert" && !deps.inlineDiffEnabled) {
    deps.notice(INSERT_NEEDS_INLINE_DIFF);
    return "skipped";
  }

  const handle = deps.openPrompt({ mode, from: target.from, to: target.to, presets: REWRITE_PRESETS });
  const instruction = await handle.instruction;
  if (!instruction) return "closed";

  const progress = deps.begin(mode === "insert" ? "Writing at the cursor…" : "Rewriting selection…");
  try {
    const raw = await deps.complete(
      mode === "insert"
        ? { system: INSERT_SYSTEM, user: buildInsertUser(target.doc.slice(0, target.from), target.doc.slice(target.from), instruction), maxTokens: 2000, temperature: 0.3, signal: handle.signal }
        : { system: REWRITE_SYSTEM, user: buildRewriteUser(selection, instruction), maxTokens: rewriteMaxTokens(selection), temperature: 0.3, signal: handle.signal },
    );
    if (handle.cancelled) return "aborted";
    handle.settle();
    const range = handle.range();
    handle.close();
    const doc = deps.currentDoc();
    if (!range || (mode === "rewrite" && doc.slice(range.from, range.to) !== selection)) {
      deps.notice(CHANGED_UNDER_EDIT);
      return "stale";
    }

    if (mode === "insert") {
      const session = createRangeSession(doc, { from: range.from, to: range.from, newText: parseInsert(raw) }, { path: deps.path, description: `Write — ${instruction}` }, { insert: true });
      progress.finish();
      const accepted = await deps.review(session);
      if (accepted) deps.notice("Inserted.");
      return accepted ? "applied" : "rejected";
    }

    const rewritten = parseRewrite(raw, selection);
    progress.finish();
    if (deps.inlineDiffEnabled) {
      const accepted = await deps.review(createRangeSession(doc, { from: range.from, to: range.to, newText: rewritten }, { path: deps.path, description: `Rewrite — ${instruction}` }));
      if (accepted) deps.notice("Rewrite applied.");
      return accepted ? "applied" : "rejected";
    }
    await deps.reviewModal({ selection, rewritten, instruction, from: range.from, to: range.to });
    return "modal";
  } catch (e) {
    if (handle.cancelled) return "aborted";
    handle.settle();
    handle.close();
    progress.fail(e);
    deps.notice(deps.failureMessage(e));
    return "failed";
  } finally {
    progress.finish();
  }
}
