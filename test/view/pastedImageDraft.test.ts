import { App, clearNotices } from "obsidian";
import { beforeEach, expect, it } from "vitest";
import { attachPastedImage, cancelPastedImages, PastedImagePreparation } from "../../src/view/chat/pastedImage";
import { loadMediaBlocks } from "../../src/view/chat/mediaBlocks";
import { buildContextManagerModel } from "../../src/view/contextManagerModel";
import type { MediaAttachment } from "../../src/context/attachments";

beforeEach(() => clearNotices());
function fixture() {
  const app = new App();
  let media: MediaAttachment[] = [];
  let resolve!: (value: ArrayBuffer) => void, reject!: (error: Error) => void;
  const read = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
  const file = { name: "Chart.png", size: 4, type: "image/png", arrayBuffer: () => read } as File;
  return { app, host: { app, media: () => media, changed: () => undefined }, file, resolve, reject, current: () => media, switchTo: (next: MediaAttachment[]) => { media = next; } };
}

it("retains a paste in its original draft when it finishes while another draft is active", async () => {
  const f = fixture();
  const task = attachPastedImage(f.file, f.host);
  const original = [...f.current()];
  f.switchTo([]);
  f.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer);
  await task;
  expect(f.current()).toEqual([]);
  expect(original).toHaveLength(1);
  expect((await loadMediaBlocks(f.app, original))[0]).toMatchObject({ type: "image", source: { data: "iVBORw==" } });
});

it("refuses a restored draft while its pasted image is still preparing", async () => {
  const f = fixture();
  const task = attachPastedImage(f.file, f.host);
  const original = [...f.current()];
  f.switchTo([]);
  const preparation = new PastedImagePreparation(f.current);
  expect(preparation.ready()).toBe(true);
  f.switchTo([...original]);
  try { expect(preparation.ready()).toBe(false); }
  finally { f.resolve(new ArrayBuffer(4)); await task; }
});

it("keeps an inactive paste failure visible and refuses sending that selected source", async () => {
  const f = fixture();
  const task = attachPastedImage(f.file, f.host);
  const original = [...f.current()];
  f.switchTo([]);
  f.reject(new Error("image read failed"));
  await task.catch(() => undefined);
  expect(original).toEqual([expect.objectContaining({ label: "Chart.png", error: "image read failed" })]);
  await expect(loadMediaBlocks(new App(), original)).rejects.toThrow("image read failed");
});

it("shows pasted image preparation and failure in Message context", () => {
  const model = buildContextManagerModel({ toggles: { activeNote: false, selection: false, linkedNotes: false, searchVault: false }, activeNotePath: null, paths: [], pages: [], media: [
    { label: "Pending.png", kind: "image", mime: "image/png", pending: true } as MediaAttachment,
    { label: "Broken.png", kind: "image", mime: "image/png", error: "read failed" } as MediaAttachment,
  ] });
  expect(model.sources.map(({ status, error }) => ({ status, error }))).toEqual([{ status: "pending", error: undefined }, { status: "error", error: "read failed" }]);
});

for (const fail of [false, true]) {
  it(`does not resurrect an explicitly removed paste after ${fail ? "failure" : "completion"}`, async () => {
    const f = fixture();
    const task = attachPastedImage(f.file, f.host);
    const original = f.current();
    cancelPastedImages(original.splice(0));
    if (fail) f.reject(new Error("cancelled read failed"));
    else f.resolve(new ArrayBuffer(4));
    await task;
    expect(original).toEqual([]);
  });
}

it("refuses pending image bytes even if a caller skips the composer readiness check", async () => {
  await expect(loadMediaBlocks(new App(), [{ label: "Pending.png", kind: "image", mime: "image/png", data: "old-data", pending: true }])).rejects.toThrow("still attaching");
});
