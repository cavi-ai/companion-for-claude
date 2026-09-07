// One chooser for every proposed-edit review: inline in the open editor, else the DiffModal.

import { MarkdownView, type App, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { EditPlan } from "../edit/diff";
import { DiffModal } from "../view/DiffModal";
import { createSession, type InlineDiffSession } from "./inlineDiffState";
import { reviewInline } from "./inlineDiffExtension";

export interface ReviewEditsInput {
  file: TFile;
  plan: EditPlan;
  description?: string;
}

export type ReviewOutcome = { mode: "inline"; accepted: boolean[] | null } | { mode: "modal"; accepted: boolean[] | null };

export interface ReviewEditsDeps {
  reviewInline: (view: EditorView, session: InlineDiffSession) => Promise<boolean[] | null>;
  openModal: (app: App, input: { path: string; description?: string; plan: EditPlan }) => Promise<boolean[] | null>;
}

const defaultDeps: ReviewEditsDeps = {
  reviewInline,
  openModal: (app, input) => new Promise((resolve) => new DiffModal(app, input, resolve).open()),
};

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

export async function reviewEdits(app: App, input: ReviewEditsInput, opts: { inlineEnabled: boolean }, deps: ReviewEditsDeps = defaultDeps): Promise<ReviewOutcome> {
  const meta = { path: input.file.path, ...(input.description !== undefined ? { description: input.description } : {}) };
  if (opts.inlineEnabled) {
    const view = findOpenMarkdownView(app, input.file.path);
    const cm = view ? editorViewOf(view.editor) : null;
    if (view && cm) {
      let session: InlineDiffSession | null;
      try {
        session = createSession(view.editor.getValue(), input.plan, meta);
      } catch {
        session = null; // buffer drifted from the planned content; the modal re-validates on apply
      }
      if (session) {
        void app.workspace.revealLeaf(view.leaf);
        return { mode: "inline", accepted: await deps.reviewInline(cm, session) };
      }
    }
  }
  return { mode: "modal", accepted: await deps.openModal(app, { ...meta, plan: input.plan }) };
}
