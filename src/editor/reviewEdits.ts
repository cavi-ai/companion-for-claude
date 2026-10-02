// One chooser for every proposed-edit review: inline in the open editor, else the DiffModal.

import { MarkdownView, type App, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { EditPlan } from "../edit/diff";
import { DiffModal } from "../view/DiffModal";
import { createSession, type InlineDiffSession } from "./inlineDiffState";
import { cancelInline, reviewInline } from "./inlineDiffExtension";

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

const defaultDeps: ReviewEditsDeps = {
  reviewInline,
  cancelInline,
  openModal: (app, input, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    const modal = new DiffModal(app, input, (accepted) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(accepted);
    });
    const onAbort = () => modal.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    modal.open();
  }),
};

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

/** Offset just past the closing fence line of a leading YAML frontmatter block; -1 when there is none. */
export function frontmatterEnd(content: string): number {
  const open = /^---\r?\n/.exec(content);
  if (!open) return -1;
  const close = /^---[ \t]*(?:\r?\n|$)/m;
  const rest = content.slice(open[0].length);
  const match = close.exec(rest);
  return match ? open[0].length + match.index + match[0].length : -1;
}

export async function reviewEdits(app: App, input: ReviewEditsInput, opts: { inlineEnabled: boolean; signal?: AbortSignal }, deps: ReviewEditsDeps = defaultDeps): Promise<ReviewOutcome> {
  const meta = { path: input.file.path, ...(input.description !== undefined ? { description: input.description } : {}) };
  if (opts.inlineEnabled) {
    const view = findOpenMarkdownView(app, input.file.path);
    const cm = view ? editorViewOf(view.editor) : null;
    // Live Preview renders frontmatter as the Properties widget, which hides inline marks and the review bar.
    const fmEnd = view ? frontmatterEnd(view.editor.getValue()) : -1;
    if (view && cm && !input.plan.hunks.some((hunk) => hunk.start < fmEnd)) {
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
