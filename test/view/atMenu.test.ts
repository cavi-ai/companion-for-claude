import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { AtItem, ClaimAtSource } from "../../src/context/atMention";
import type { AttachedPath } from "../../src/context/vaultContext";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";

function fixture() {
  const app = new App();
  app.vault.seed("Notes/Alpha.md", "alpha body");
  app.vault.seed("DB/Tracker.base", "views: []");
  app.workspace = {
    getLeaf: () => ({ openFile: async () => undefined }),
    getActiveFile: () => null,
    getLastOpenFiles: () => ["Notes/Alpha.md"],
  } as typeof app.workspace;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.context = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
  const saveSettings = vi.fn(async () => undefined);
  const researchRepository = vi.fn(() => ({
    listProjects: async () => [],
    loadProject: async () => ({ claims: [] }),
  }));
  const plugin = { settings, saveSettings, researchRepository } as unknown as ClaudeCompanionPlugin;
  const view = new ChatView(new WorkspaceLeaf(app), plugin);
  const seam = view as unknown as {
    attachedPaths: AttachedPath[];
    cachedClaims: ClaimAtSource[];
    activeMenuTrigger: "@" | "#";
    inputEl: FakeElement & { setSelectionRange(start: number, end: number): void };
    updateUsageBar(): void;
    resolveMarkdownContextView(): null;
    atItems(): AtItem[];
    hashItems(): AtItem[];
    onAtChoose(item: AtItem): Promise<void>;
    scheduleReloadClaims(): void;
    claimReloadTimer: number | null;
  };
  seam.attachedPaths = [];
  seam.cachedClaims = [{ path: "Research/Proj/Claims/C1.md", label: "Raft leader election avoids split votes", project: "Proj" }];
  seam.activeMenuTrigger = "@";
  seam.inputEl = Object.assign(new FakeElement(), { setSelectionRange: () => undefined }) as unknown as typeof seam.inputEl;
  seam.inputEl.value = "";
  seam.updateUsageBar = vi.fn();
  seam.resolveMarkdownContextView = () => null;
  return { seam, plugin, saveSettings, researchRepository };
}

describe("'@'/'#' picker: bases, claims, recents", () => {
  it("'#' lists only claim items, not notes/bases/specials", () => {
    const { seam } = fixture();
    const items = seam.hashItems();
    expect(items).toEqual([
      { id: "claim:Research/Proj/Claims/C1.md", kind: "claim", label: "Raft leader election avoids split votes", sublabel: "Proj", path: "Research/Proj/Claims/C1.md" },
    ]);
  });

  it("'#' shows nothing when there are no claims", () => {
    const { seam } = fixture();
    seam.cachedClaims = [];
    expect(seam.hashItems()).toEqual([]);
  });

  it("atItems() offers the .base file and the recently opened note", () => {
    const { seam } = fixture();
    const items = seam.atItems();
    expect(items.find((i) => i.kind === "base-path")).toMatchObject({ label: "Tracker.base", path: "DB/Tracker.base" });
    expect(items.find((i) => i.kind === "recent")).toMatchObject({ label: "Recent · Alpha", path: "Notes/Alpha.md" });
    expect(items.find((i) => i.kind === "claim")).toMatchObject({ path: "Research/Proj/Claims/C1.md" });
  });

  it("choosing a base attaches once, even if chosen twice", async () => {
    const { seam } = fixture();
    const baseItem = seam.atItems().find((i) => i.kind === "base-path")!;
    await seam.onAtChoose(baseItem);
    await seam.onAtChoose(baseItem);
    expect(seam.attachedPaths).toEqual([{ path: "DB/Tracker.base", kind: "note" }]);
  });

  it("choosing a claim attaches its note by path", async () => {
    const { seam } = fixture();
    const claimItem = seam.atItems().find((i) => i.kind === "claim")!;
    await seam.onAtChoose(claimItem);
    expect(seam.attachedPaths).toEqual([{ path: "Research/Proj/Claims/C1.md", kind: "note" }]);
  });

  it("choosing a recent attaches as a note and dedupes against an existing note-path", async () => {
    const { seam } = fixture();
    seam.attachedPaths = [{ path: "Notes/Alpha.md", kind: "note" }];
    const recentItem = seam.atItems().find((i) => i.kind === "recent")!;
    await seam.onAtChoose(recentItem);
    expect(seam.attachedPaths).toEqual([{ path: "Notes/Alpha.md", kind: "note" }]);
  });

  it("strips the '#query' token (not '@') when choosing from the hash trigger", async () => {
    const { seam } = fixture();
    seam.activeMenuTrigger = "#";
    seam.inputEl.value = "check #split";
    seam.inputEl.selectionStart = seam.inputEl.value.length;
    const claimItem = seam.hashItems()[0]!;
    await seam.onAtChoose(claimItem);
    expect(seam.inputEl.value).toBe("check ");
  });
});

describe("claim reload coalescing", () => {
  it("three rapid change events cause one repository load", async () => {
    vi.useFakeTimers();
    try {
      const { seam, researchRepository } = fixture();
      researchRepository.mockClear();
      seam.scheduleReloadClaims();
      seam.scheduleReloadClaims();
      seam.scheduleReloadClaims();
      expect(researchRepository).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(researchRepository).toHaveBeenCalledTimes(1);
      expect(seam.claimReloadTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
