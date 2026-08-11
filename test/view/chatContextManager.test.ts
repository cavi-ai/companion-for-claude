import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { MediaAttachment } from "../../src/context/attachments";
import type { AttachedPage } from "../../src/context/urlContext";
import type { AttachedPath } from "../../src/context/vaultContext";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { ComposerContextManager } from "../../src/view/ComposerContextManager";
import { ChatView } from "../../src/view/ChatView";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function fixture(capture: () => Promise<{ markdown: string; title?: string } | null> = async () => null) {
  const app = new App();
  app.workspace = {
    getLeaf: () => ({ openFile: async () => undefined }),
    getActiveFile: () => null,
  } as typeof app.workspace;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.context = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
  const saveSettings = vi.fn(async () => undefined);
  const plugin = {
    settings,
    saveSettings,
    captureWebPage: () => capture,
  } as unknown as ClaudeCompanionPlugin;
  const view = new ChatView(new WorkspaceLeaf(app), plugin);
  const rendered: unknown[] = [];
  const manager = {
    render: (model: unknown) => { rendered.push(model); },
    close: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ComposerContextManager;
  const seam = view as unknown as {
    attachedPaths: AttachedPath[];
    attachedMedia: MediaAttachment[];
    attachedPages: AttachedPage[];
    contextManager: ComposerContextManager;
    lastContextManagerSignature: string;
    inputEl: FakeElement;
    atMenu: { isOpen(): boolean };
    resolveMarkdownContextView(): null;
    updateUsageBar(): void;
    renderContextManager(): void;
    toggleAutomaticContext(key: "activeNote" | "selection" | "linkedNotes" | "searchVault", enabled: boolean): void;
    removeContextSource(id: string): void;
    retryContextSource(id: string): void;
    openContextPicker(): void;
  };
  seam.attachedPaths = [];
  seam.attachedMedia = [];
  seam.attachedPages = [];
  seam.contextManager = manager;
  seam.lastContextManagerSignature = "";
  seam.resolveMarkdownContextView = () => null;
  seam.updateUsageBar = vi.fn();
  return { view, seam, plugin, saveSettings, rendered };
}

describe("ChatView context manager wiring", () => {
  it("persists automatic toggles and refreshes the presentation model", async () => {
    const { seam, plugin, saveSettings, rendered } = fixture();

    seam.toggleAutomaticContext("activeNote", true);
    await Promise.resolve();

    expect(plugin.settings.context.activeNote).toBe(true);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ activeCount: 1, summary: "Context · This note" });
  });

  it("removes exact session sources without persisting or changing neighboring inputs", () => {
    const { seam, plugin, saveSettings } = fixture();
    seam.attachedPaths = [{ kind: "note", path: "Notes/Alpha.md" }];
    seam.attachedMedia = [{ kind: "pdf", label: "Study.pdf", mime: "application/pdf", path: "Files/Study.pdf" }];
    seam.attachedPages = [{ url: "https://example.test/article", title: "Article", markdown: "body" }];

    seam.removeContextSource("media:pdf:Files/Study.pdf");

    expect(seam.attachedPaths).toEqual([{ kind: "note", path: "Notes/Alpha.md" }]);
    expect(seam.attachedMedia).toEqual([]);
    expect(seam.attachedPages).toEqual([{ url: "https://example.test/article", title: "Article", markdown: "body" }]);
    expect(plugin.settings.context).toEqual({ activeNote: false, selection: false, linkedNotes: false, searchVault: false });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("retries a failed page in place, exposes pending state, and does not duplicate it", async () => {
    const capture = deferred<{ markdown: string; title: string }>();
    const { seam, rendered } = fixture(() => capture.promise);
    seam.attachedPages = [{ url: "https://example.test/article", markdown: "", error: "Timed out" }];

    seam.retryContextSource("page:https://example.test/article");

    expect(seam.attachedPages).toHaveLength(1);
    expect(seam.attachedPages[0]).toMatchObject({ pending: true });
    expect(seam.attachedPages[0]?.error).toBeUndefined();
    expect(rendered.at(-1)).toMatchObject({ sources: [expect.objectContaining({ status: "pending" })] });

    capture.resolve({ markdown: "Captured body", title: "Recovered article" });
    await capture.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(seam.attachedPages).toEqual([{ url: "https://example.test/article", markdown: "Captured body", title: "Recovered article", pending: false }]);
    expect(rendered.at(-1)).toMatchObject({ sources: [expect.objectContaining({ status: "ready", label: "Recovered article" })] });
  });
});
