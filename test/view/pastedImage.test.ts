import { App, TFile, clearNotices, getNoticeMessages } from "obsidian";
import { beforeEach, expect, it, vi } from "vitest";
import { loadMediaBlocks } from "../../src/view/chat/mediaBlocks";
import { attachPastedImage } from "../../src/view/chat/pastedImage";
import type { MediaAttachment } from "../../src/context/attachments";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
function fixture() {
  const app = new App();
  const media: MediaAttachment[] = [];
  const file = { name: "Chart.jpg", size: png.length, type: "image/jpeg", arrayBuffer: async () => png.buffer } as File;
  return { app, media, file, host: { app, media: () => media, changed: () => undefined } };
}

beforeEach(() => { clearNotices(); });

it("saves a pasted image as a vault attachment with its detected format", async () => {
  const { app, media, file, host } = fixture();
  await attachPastedImage(file, host);
  expect(media[0]).toMatchObject({ kind: "image", mime: "image/png", path: "Attachments/Chart.png" });
  expect(media[0]?.data).toBeUndefined();
  const saved = app.vault.getAbstractFileByPath("Attachments/Chart.png");
  expect(saved).toBeInstanceOf(TFile);
  expect(new Uint8Array(await app.vault.readBinary(saved as TFile))).toEqual(png);
});

it("keeps both files when two same-name images are pasted concurrently", async () => {
  const { app, media, file, host } = fixture();
  await Promise.all([attachPastedImage(file, host), attachPastedImage(file, host)]);
  expect(media.map((item) => item.path).sort()).toEqual(["Attachments/Chart 1.png", "Attachments/Chart.png"]);
  expect(app.vault.getFiles()).toHaveLength(2);
});

it("reports a failed attachment save without claiming an image was attached", async () => {
  const { app, media, file, host } = fixture();
  vi.spyOn(app.vault, "createBinary").mockRejectedValue(new Error("disk full"));
  await attachPastedImage(file, host);
  expect(media).toEqual([expect.objectContaining({ label: "Chart.jpg", error: "disk full" })]);
  expect(media[0]?.pending).toBeUndefined();
  expect(app.vault.getFiles()).toEqual([]);
  await expect(loadMediaBlocks(app, media)).rejects.toThrow("disk full");
  expect(getNoticeMessages().join(" ")).toContain("disk full");
  expect(getNoticeMessages().join(" ")).not.toContain("Image saved");
});
