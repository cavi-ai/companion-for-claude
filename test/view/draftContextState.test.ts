import { describe, expect, it } from "vitest";
import { draftContextState, restoreDraftContext } from "../../src/view/chat/draftContextState";
import type { Composer } from "../../src/view/chat/Composer";
import { App } from "obsidian";
import { gatherContext } from "../../src/context/vaultContext";
import { MAX_PAGE_CONTEXT_CHARS } from "../../src/context/urlContext";
import { DEFAULT_SETTINGS } from "../../src/types";

const OFF = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
function composer() {
  return { contextToggles: { ...OFF }, attachedPaths: [], attachedMedia: [], attachedPages: [], renderContextManager: () => undefined } as unknown as Composer;
}

describe("draft context state", () => {
  it("restores a ready captured page with its title and excerpt", () => {
    const original = composer();
    original.attachedPages = [{ url: "https://example.test/article", title: "Selected article", markdown: "Captured excerpt" }];
    const restored = composer();
    restoreDraftContext(restored, JSON.parse(JSON.stringify(draftContextState(original, OFF))));
    expect(restored.attachedPages).toEqual(original.attachedPages);
    expect(restored.attachedPages[0]).not.toBe(original.attachedPages[0]);
  });

  it("bounds persisted page text while preserving the request's clipped content", async () => {
    const original = composer();
    original.attachedPages = [{ url: "https://example.test/article", title: "Article", markdown: "Long content. ".repeat(2000) + "UNUSED-TAIL" }];
    const app = new App();
    app.workspace.getActiveViewOfType = () => null;
    app.workspace.getActiveFile = () => null;
    const before = await gatherContext(app, DEFAULT_SETTINGS, OFF, "question", undefined, [], original.attachedPages);
    const serialized = JSON.stringify(draftContextState(original, OFF));
    const restored = composer();
    restoreDraftContext(restored, JSON.parse(serialized));
    expect(restored.attachedPages[0]?.markdown).toHaveLength(MAX_PAGE_CONTEXT_CHARS);
    expect(serialized).not.toContain("UNUSED-TAIL");
    expect(await gatherContext(app, DEFAULT_SETTINGS, OFF, "question", undefined, [], restored.attachedPages)).toEqual(before);
  });

  it("retains a failed capture's retry state without storing stale page content", () => {
    const original = composer();
    original.attachedPages = [{ url: "https://example.test/article", markdown: "stale text", error: "Fetch failed" }];
    const serialized = JSON.stringify(draftContextState(original, OFF));
    const restored = composer();
    restoreDraftContext(restored, JSON.parse(serialized));
    expect(restored.attachedPages).toEqual([{ url: "https://example.test/article", markdown: "", error: "Fetch failed" }]);
    expect(serialized).not.toContain("stale text");
  });

  it("ignores malformed page records and invalid metadata from saved state", () => {
    const restored = composer();
    restoreDraftContext(restored, { context: { pages: [null, { url: "javascript:alert(1)", markdown: "bad" }, { url: "https://example.test", markdown: 4 }, { url: "https://example.test/article", markdown: "body", title: {}, error: 7, pending: "true" }] } });
    expect(restored.attachedPages).toEqual([{ url: "https://example.test/article", markdown: "body" }]);
  });

  it("restores an interrupted capture as a retryable error without changing the live capture", () => {
    const original = composer();
    original.attachedPages = [{ url: "https://example.test/article", markdown: "", pending: true }];
    const restored = composer();
    restoreDraftContext(restored, JSON.parse(JSON.stringify(draftContextState(original, OFF))));
    expect(restored.attachedPages[0]?.error).toContain("interrupted");
    expect(restored.attachedPages[0]?.pending).toBeFalsy();
    expect(original.attachedPages[0]?.pending).toBe(true);
  });

  it("restores vault image and PDF references without serializing their bytes", () => {
    const original = composer();
    original.attachedMedia = [
      { kind: "image", label: "Chart", path: "Notes/chart.png", mime: "image/png", data: "inline-image-bytes" },
      { kind: "pdf", label: "Paper", path: "Notes/paper.pdf", mime: "application/pdf" },
    ];
    const serialized = JSON.stringify(draftContextState(original, OFF));
    const restored = composer();
    restoreDraftContext(restored, JSON.parse(serialized));
    expect(restored.attachedMedia).toEqual([
      { kind: "image", label: "Chart", path: "Notes/chart.png", mime: "image/png" },
      { kind: "pdf", label: "Paper", path: "Notes/paper.pdf", mime: "application/pdf" },
    ]);
    expect(serialized).not.toContain("inline-image-bytes");
  });

  it("ignores invalid media references and derives MIME from the file type", () => {
    const restored = composer();
    restoreDraftContext(restored, { context: { media: [null, { kind: "image", label: "bad", path: "Notes/file.md" }, { kind: "pdf", label: "Paper", path: "Notes/paper.pdf", mime: "text/html" }] } });
    expect(restored.attachedMedia).toEqual([{ kind: "pdf", label: "Paper", path: "Notes/paper.pdf", mime: "application/pdf" }]);
  });

  it("omits unchanged defaults from legacy-compatible empty state", () => {
    expect(draftContextState(composer(), OFF)).toEqual({});
  });

  it("round-trips explicit notes, folders, and the pane's context choices", () => {
    const original = composer();
    original.contextToggles.searchVault = true;
    original.attachedPaths = [{ path: "Notes/Source.md", kind: "note" }, { path: "Research", kind: "folder" }];
    const state: unknown = JSON.parse(JSON.stringify(draftContextState(original, OFF)));
    const restored = composer();
    restoreDraftContext(restored, state);
    expect(restored.contextToggles).toEqual({ ...OFF, searchVault: true });
    expect(restored.attachedPaths).toEqual([{ path: "Notes/Source.md", kind: "note" }, { path: "Research", kind: "folder" }]);
  });

  it("does not change context when an older view state omits it", () => {
    const restored = composer();
    restored.contextToggles.linkedNotes = true;
    restoreDraftContext(restored, { conversationId: null });
    expect(restored.contextToggles.linkedNotes).toBe(true);
  });

  it("ignores malformed context fields and invalid attachment kinds", () => {
    const restored = composer();
    restoreDraftContext(restored, { context: { automatic: { activeNote: "false", searchVault: true }, paths: [null, { kind: "image", path: "a.png" }, { kind: "note", path: 4 }, { kind: "note", path: "Notes/Source.md" }] } });
    expect(restored.contextToggles).toEqual({ ...OFF, searchVault: true });
    expect(restored.attachedPaths).toEqual([{ kind: "note", path: "Notes/Source.md" }]);
  });
});

for (const state of ["pending", "failed", "inline"] as const) {
  it(`restores a ${state} unbacked image as an explicit reattachment requirement`, () => {
    const original = composer();
    original.attachedMedia = [{ label: "Unfinished.png", kind: "image", mime: "image/png", ...(state === "pending" ? { pending: true } : state === "failed" ? { error: "Image read failed" } : { data: "private-inline-bytes" }) }];
    const before = structuredClone(original.attachedMedia);
    const serialized = JSON.stringify(draftContextState(original, OFF));
    const restored = composer();
    restoreDraftContext(restored, JSON.parse(serialized));
    expect(restored.attachedMedia).toHaveLength(1);
    expect(restored.attachedMedia[0]).toMatchObject({ label: "Unfinished.png", kind: "image" });
    expect(restored.attachedMedia[0]?.error).toBeTruthy();
    expect(restored.attachedMedia[0]?.pending).toBeUndefined();
    expect(restored.attachedMedia[0]?.data).toBeUndefined();
    expect(serialized).not.toContain("private-inline-bytes");
    expect(original.attachedMedia).toEqual(before);
  });
}

it("does not turn arbitrary saved objects into attachable image payloads", () => {
  const restored = composer();
  restoreDraftContext(restored, { context: { media: [
    { label: "wrong", kind: "executable", error: "bad" },
    { label: "not marked", kind: "image", data: "injected-bytes" },
    { label: "interrupted", kind: "image", error: "Reattach this image", data: "injected-bytes", pending: true },
  ] } });
  expect(restored.attachedMedia).toEqual([{ label: "interrupted", kind: "image", mime: "image/png", error: "Reattach this image" }]);
});
