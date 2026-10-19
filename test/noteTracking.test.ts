import { App, MarkdownView } from "obsidian";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "./fakes/plugin";

function setup() {
  const app = new App();
  const view = new MarkdownView();
  Object.assign(app.workspace, { getActiveViewOfType: () => view });
  const plugin = buildPlugin({
    lastMarkdownFile: null,
    registerEvent: () => undefined,
    research: () => ({ syncPlanBuildActions: () => undefined }),
  }, app);
  (plugin as unknown as { registerNoteTracking(): void }).registerNoteTracking();
  return { app, view, plugin };
}

describe("last Markdown note tracking", () => {
  it("remembers a file that finishes opening after its leaf becomes active", () => {
    const { app, view, plugin } = setup();
    app.workspace.trigger("active-leaf-change", null);
    const note = app.vault.seed("Incident notes.md", "# Incident notes");
    view.file = note;
    app.workspace.trigger("file-open", note);
    view.file = null;
    app.workspace.trigger("active-leaf-change", null);
    expect(plugin.lastMarkdownFile?.path).toBe("Incident notes.md");
  });

  it("updates the note when another file opens in the same leaf", () => {
    const { app, plugin } = setup();
    app.workspace.trigger("file-open", app.vault.seed("First.md", "First"));
    app.workspace.trigger("file-open", app.vault.seed("Next.md", "Next"));
    expect(plugin.lastMarkdownFile?.path).toBe("Next.md");
  });

  it("keeps the last Markdown note when a PDF or empty view opens", () => {
    const { app, view, plugin } = setup();
    view.file = app.vault.seed("Note.md", "A note");
    app.workspace.trigger("active-leaf-change", null);
    app.workspace.trigger("file-open", app.vault.seed("Paper.pdf", "binary"));
    app.workspace.trigger("file-open", null);
    expect(plugin.lastMarkdownFile?.path).toBe("Note.md");
  });
});
