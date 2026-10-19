import { App, clearNotices, getNoticeMessages, TFile } from "obsidian";
import { beforeEach, expect, it, vi } from "vitest";
import { Composer, type ComposerDeps } from "../../src/view/chat/Composer";
import type { ComposerHost } from "../../src/view/chat/hosts";
import type { ChatSession } from "../../src/view/chat/chatSession";
import { DEFAULT_SETTINGS } from "../../src/types";

function fixture() {
  const app = new App();
  const composer = new Composer(app, { settings: DEFAULT_SETTINGS } as ComposerHost, {} as ChatSession, {} as ComposerDeps);
  composer.attachedMedia = [{ kind: "image", label: "Chart.png", mime: "image/png", path: "Chart.png" }];
  return { app, composer };
}
beforeEach(() => clearNotices());

it("loads the selected image bytes into the request", async () => {
  const { app, composer } = fixture();
  app.vault.seed("Chart.png", String.fromCharCode(0x89, 0x50, 0x4e, 0x47));
  expect(await composer.mediaBlocks()).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } }]);
});

it("refuses an unavailable image instead of returning a partial request", async () => {
  const { composer } = fixture();
  expect(await composer.mediaBlocks()).toBeNull();
  expect(getNoticeMessages().join(" ")).toContain("Reattach");
});

it("refuses a read failure while retaining the selected attachment", async () => {
  const { app, composer } = fixture();
  app.vault.seed("Chart.png", "bytes");
  vi.spyOn(app.vault, "readBinary").mockRejectedValue(new Error("read denied"));
  expect(await composer.mediaBlocks()).toBeNull();
  expect(composer.attachedMedia).toHaveLength(1);
  expect(getNoticeMessages().join(" ")).toContain("read denied");
});

it("refuses an oversized selected image instead of silently omitting it", async () => {
  const { app, composer } = fixture();
  app.vault.seed("Chart.png", "bytes");
  (app.vault.getAbstractFileByPath("Chart.png") as TFile).stat.size = 6 * 1024 * 1024;
  expect(await composer.mediaBlocks()).toBeNull();
  expect(getNoticeMessages().join(" ")).toContain("too large");
});

for (const kind of ["image", "note"] as const) {
  it(`refuses a failed ${kind} read without posting its notice in a newer draft`, async () => {
    const { app, composer } = fixture();
    app.vault.seed(kind === "image" ? "Chart.png" : "Note.md", "source");
    let reject!: (error: Error) => void;
    let current = true;
    if (kind === "image") vi.spyOn(app.vault, "readBinary").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    else vi.spyOn(app.vault, "cachedRead").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const preparing = kind === "image" ? composer.mediaBlocks(undefined, () => current) : composer.noteContext([{ path: "Note.md", kind: "note" }], () => current);
    current = false;
    reject(new Error("Source read failed"));
    expect(await preparing).toBeNull();
    expect(getNoticeMessages()).toEqual([]);
    expect(composer.attachedMedia).toEqual([{ kind: "image", label: "Chart.png", mime: "image/png", path: "Chart.png" }]);
  });
}
