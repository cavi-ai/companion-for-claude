import { App, TFile, TFolder } from "obsidian";
import { expect, it, vi } from "vitest";
import { watchAttachmentRenames } from "../../src/view/chat/attachmentRenames";

it("updates live image and note references when their folder moves", () => {
  const app = new App();
  const host = {
    attachedPaths: [{ path: "Drafts/Note.md", kind: "note" as const }, { path: "Drafts-old/Note.md", kind: "note" as const }],
    attachedMedia: [{ path: "Drafts/Chart.png", label: "Chart.png", kind: "image" as const, mime: "image/png" }],
    renderContextManager: vi.fn(),
  };
  watchAttachmentRenames(app.vault, host, () => undefined);
  app.vault.trigger("rename", new TFolder("Archive"), "Drafts");
  expect(host.attachedPaths.map((item) => item.path)).toEqual(["Archive/Note.md", "Drafts-old/Note.md"]);
  expect(host.attachedMedia[0]?.path).toBe("Archive/Chart.png");
  expect(host.renderContextManager).toHaveBeenCalledOnce();
});

it("refreshes renamed image labels and unregisters with the view lifecycle", () => {
  const app = new App();
  const host = {
    attachedPaths: [],
    attachedMedia: [{ path: "Before.png", label: "Before.png", kind: "image" as const, mime: "image/png" }],
    renderContextManager: vi.fn(),
  };
  const refs: Parameters<typeof app.vault.offref>[0][] = [];
  watchAttachmentRenames(app.vault, host, (ref) => refs.push(ref));
  app.vault.trigger("rename", new TFile("After.png", "", 1), "Before.png");
  expect(host.attachedMedia[0]).toMatchObject({ path: "After.png", label: "After.png" });
  refs.forEach((ref) => app.vault.offref(ref));
  app.vault.trigger("rename", new TFile("Later.png", "", 1), "After.png");
  expect(host.attachedMedia[0]?.path).toBe("After.png");
});
