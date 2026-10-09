// One chooser for every proposed-edit review: inline in the open editor, else the DiffModal.

import { MarkdownView, type App, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { EditPlan } from "../edit/diff";
import { DiffModal } from "../view/DiffModal";
import { createSession, type InlineDiffSession } from "./inlineDiffState";
import { cancelInline } from "./inlineDiffExtension";
import { reviewInlineWithKeys } from "./reviewKeys";
import { fenceAt, fenceEnd } from "../markdown/fences";
import { frontmatterBlock } from "../markdown/frontmatter";

export interface ReviewEditsInput {
  file: TFile;
  plan: EditPlan;
  description?: string;
}

export type ReviewOutcome = { mode: "inline"; accepted: boolean[] | null } | { mode: "modal"; accepted: boolean[] | null };

export interface ReviewEditsDeps {
  reviewInline: (view: EditorView, session: InlineDiffSession) => Promise<boolean[] | null>;
  cancelInline?: (view: EditorView) => void;
  openModal: (app: App, input: { path: string; description?: string; plan: EditPlan }, signal?: AbortSignal) => Promise<boolean[] | null>;
}

const defaultDeps = (app: App): ReviewEditsDeps => ({
  reviewInline: (view, session) => reviewInlineWithKeys(app, view, session),
  cancelInline,
  openModal: (modalApp, input, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    const modal = new DiffModal(modalApp, input, (accepted) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(accepted);
    });
    const onAbort = () => modal.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    modal.open();
  }),
});

function awaitReview(pending: Promise<boolean[] | null>, signal: AbortSignal | undefined, cancel: () => void): Promise<boolean[] | null> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => { cancel(); finish(null); };
    const finish = (accepted: boolean[] | null) => { signal.removeEventListener("abort", onAbort); resolve(accepted); };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(finish, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error(String(error))); });
    if (signal.aborted) onAbort();
  });
}

/** Obsidian's Editor wraps a CM6 view as `cm`; absent on non-CM editors. */
export function editorViewOf(editor: unknown): EditorView | null {
  const cm = (editor as { cm?: EditorView } | null)?.cm;
  return cm ?? null;
}

export function findOpenMarkdownView(app: App, path: string): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) return view;
  }
  return null;
}

export interface HiddenRange { from: number; to: number }

interface Line { from: number; to: number; text: string }

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from < content.length) {
    const nl = content.indexOf("\n", from);
    const to = nl === -1 ? content.length : nl + 1;
    lines.push({ from, to, text: content.slice(from, nl === -1 ? to : nl).replace(/\r$/, "") });
    from = to;
  }
  return lines;
}

/** Char ranges Live Preview replaces with widgets (whole lines), where inline diff marks and the review bar do not render. */
export function hiddenRanges(content: string): HiddenRange[] {
  const lines = splitLines(content);
  const ranges: HiddenRange[] = [];
  const push = (first: number, last: number) => ranges.push({ from: lines[first]!.from, to: lines[last]!.to });
  let i = 0;
  const frontmatter = frontmatterBlock(content);
  if (frontmatter) { push(0, frontmatter.closeLine); i = frontmatter.closeLine + 1; }
  const texts = lines.map((line) => line.text);
  while (i < lines.length) {
    const text = lines[i]!.text;
    const trimmed = text.trim();
    const fence = fenceAt(texts, i);
    if (fence) {
      const end = fenceEnd(texts, i, fence);
      push(i, end);
      i = end + 1;
    } else if (trimmed.startsWith("$$")) {
      let end = i;
      if (!(trimmed.length >= 4 && trimmed.endsWith("$$"))) {
        end = lines.length - 1;
        for (let j = i + 1; j < lines.length; j++) if (lines[j]!.text.trim().endsWith("$$")) { end = j; break; }
      }
      push(i, end);
      i = end + 1;
    } else if (trimmed.startsWith("|")) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1]!.text.trim().startsWith("|")) end++;
      push(i, end);
      i = end + 1;
    } else if (/^>\s*\[!/.test(text)) {
      let end = i;
      while (end + 1 < lines.length && /^\s*>/.test(lines[end + 1]!.text)) end++;
      push(i, end);
      i = end + 1;
    } else if (/^<[A-Za-z]/.test(text)) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1]!.text.trim() !== "") end++;
      push(i, end);
      i = end + 1;
    } else {
      if (/^!\[\[[^\]]*\]\]$/.test(trimmed)) push(i, i);
      i++;
    }
  }
  return ranges;
}

function touchesHidden(plan: EditPlan, ranges: HiddenRange[]): boolean {
  return plan.hunks.some((hunk) => ranges.some((range) => hunk.start < range.to && hunk.start + Math.max(hunk.oldText.length, 1) > range.from));
}

export async function reviewEdits(app: App, input: ReviewEditsInput, opts: { inlineEnabled: boolean; signal?: AbortSignal }, deps: ReviewEditsDeps = defaultDeps(app)): Promise<ReviewOutcome> {
  const meta = { path: input.file.path, ...(input.description !== undefined ? { description: input.description } : {}) };
  if (opts.inlineEnabled) {
    const view = findOpenMarkdownView(app, input.file.path);
    const cm = view ? editorViewOf(view.editor) : null;
    // Live Preview widgets (properties, tables, callouts, rendered blocks) hide inline marks and the review bar; source mode shows them.
    const inlineVisible = view !== null && (view.getState().source === true || !touchesHidden(input.plan, hiddenRanges(view.editor.getValue())));
    if (view && cm && inlineVisible) {
      let session: InlineDiffSession | null;
      try {
        session = createSession(view.editor.getValue(), input.plan, meta);
      } catch {
        session = null; // buffer drifted from the planned content; the modal re-validates on apply
      }
      if (session) {
        void app.workspace.revealLeaf(view.leaf);
        return { mode: "inline", accepted: await awaitReview(deps.reviewInline(cm, session), opts.signal, () => deps.cancelInline?.(cm)) };
      }
    }
  }
  return { mode: "modal", accepted: await awaitReview(deps.openModal(app, { ...meta, plan: input.plan }, opts.signal), opts.signal, () => undefined) };
}
