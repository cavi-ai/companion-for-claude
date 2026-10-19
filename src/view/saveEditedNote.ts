import { MarkdownView, type App, type TFile } from "obsidian";

/** Obsidian save() can return early when autosave is already in flight. */
async function saveEditor(app: App, view: MarkdownView, file: TFile): Promise<void> {
  const path = file.path;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      app.vault.offref(changed);
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)));
    const check = async () => {
      if (settled) return;
      try {
        if (view.file?.path !== path) throw new Error("The edited note changed before it could be saved. Retry enrichment.");
        const expected = view.getViewData();
        const saved = await app.vault.read(file);
        if (saved === expected && view.getViewData() === expected) finish();
      } catch (error) { fail(error); }
    };
    const changed = app.vault.on("modify", (changedFile) => { if (changedFile.path === path) void check(); });
    const timer = window.setTimeout(() => finish(new Error("The note did not finish saving. Retry enrichment after saving it.")), 10_000);
    void Promise.resolve().then(() => view.save()).then(check, fail);
  });
}

/** Flush only editors for the requested note, leaving unrelated drafts alone. */
export async function saveEditedNote(app: App, file: TFile): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) await saveEditor(app, leaf.view, file);
  }
}
