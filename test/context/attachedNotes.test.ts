import { App, TFile } from "obsidian";
import { expect, it, vi } from "vitest";
import { loadAttachedNotes } from "../../src/context/attachedNotes";
import { gatherContext, type AttachedPath } from "../../src/context/vaultContext";
import { DEFAULT_SETTINGS } from "../../src/types";

const OFF = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
function fixture() {
  const app = new App();
  app.workspace.getActiveViewOfType = () => null;
  app.workspace.getActiveFile = () => null;
  return app;
}

it.each(["note", "folder"] as const)("refuses a missing selected %s", async (kind) => {
  await expect(loadAttachedNotes(fixture(), [{ path: "Missing", kind }], 3)).rejects.toThrow("Couldn't attach Missing");
});

it("refuses unreadable selected content instead of returning partial notes", async () => {
  const app = fixture();
  app.vault.seed("First.md", "readable");
  app.vault.seed("Second.md", "unavailable");
  const read = app.vault.cachedRead.bind(app.vault);
  vi.spyOn(app.vault, "cachedRead").mockImplementation((file) => file.path === "Second.md" ? Promise.reject(new Error("read denied")) : read(file));
  await expect(loadAttachedNotes(app, [{ path: "First.md", kind: "note" }, { path: "Second.md", kind: "note" }], 3)).rejects.toThrow("Second.md: read denied");
});

it("expands selected folders newest first with the existing cap and path boundary", async () => {
  const app = fixture();
  app.vault.seed("Selected/Old.md", "old", { mtime: 1 });
  app.vault.seed("Selected/New.md", "new", { mtime: 3 });
  app.vault.seed("Selected/Nested/Mid.md", "mid", { mtime: 2 });
  app.vault.seed("Selected-old/Other.md", "other", { mtime: 4 });
  const notes = await loadAttachedNotes(app, [{ path: "Selected", kind: "folder" }], 2);
  expect(notes.map((note) => note.path)).toEqual(["Selected/New.md", "Selected/Nested/Mid.md"]);
});

it("keeps captured content usable after the source is renamed", async () => {
  const app = fixture();
  app.vault.seed("Source.md", "source content");
  const notes = await loadAttachedNotes(app, [{ path: "Source.md", kind: "note" }], 2);
  await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Source.md") as TFile, "Renamed.md");
  const context = await gatherContext(app, DEFAULT_SETTINGS, OFF, "question", undefined, [], [], undefined, undefined, notes);
  expect(context.text).toContain("Attached: Source.md");
  expect(context.text).toContain("source content");
  expect(context.sources).toEqual(["1 attached"]);
});

it("applies the same budget clipping to prepared notes without reading them twice", async () => {
  const app = fixture();
  app.vault.seed("Data.base", "views: []\n".repeat(200));
  const paths: AttachedPath[] = [{ path: "Data.base", kind: "note" }];
  const settings = { ...DEFAULT_SETTINGS, contextCharBudget: 100 };
  const legacy = await gatherContext(app, settings, OFF, "question", undefined, paths);
  const read = vi.spyOn(app.vault, "cachedRead");
  const notes = await loadAttachedNotes(app, paths, 2);
  const context = await gatherContext(app, settings, OFF, "question", undefined, [], [], undefined, undefined, notes);
  expect(context).toEqual(legacy);
  expect(read).toHaveBeenCalledOnce();
});
