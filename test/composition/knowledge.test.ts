import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

type Deps = Record<string, (...args: never[]) => unknown> & Record<string, unknown>;

const captured = vi.hoisted(() => ({
  semantic: undefined as Deps | undefined,
  enrichment: undefined as Deps | undefined,
  memory: undefined as Deps | undefined,
  clippings: undefined as Deps | undefined,
  modals: [] as { kind: string; args: unknown[]; opened: number }[],
}));

vi.mock("../../src/semantic/controller", () => ({
  SemanticController: class {
    constructor(deps: Deps) {
      captured.semantic = deps;
    }
  },
}));
vi.mock("../../src/sources/controller", () => ({
  SourceEnrichmentController: class {
    constructor(deps: Deps) {
      captured.enrichment = deps;
    }
  },
}));
vi.mock("../../src/memory/controller", () => ({
  MemoryController: class {
    constructor(deps: Deps) {
      captured.memory = deps;
    }
  },
}));
vi.mock("../../src/sources/clippings", () => ({
  ClippingsController: class {
    constructor(deps: Deps) {
      captured.clippings = deps;
    }
  },
}));
vi.mock("../../src/view/ChoiceModal", () => ({
  ChoiceModal: class {
    record = { kind: "choice", args: [] as unknown[], opened: 0 };
    constructor(...args: unknown[]) {
      this.record.args = args;
      captured.modals.push(this.record);
    }
    open = (): string => {
      this.record.opened += 1;
      return "choice-open-result";
    };
  },
}));
vi.mock("../../src/view/SessionPicker", () => ({
  SessionPicker: class {
    record = { kind: "session", args: [] as unknown[], opened: 0 };
    constructor(...args: unknown[]) {
      this.record.args = args;
      captured.modals.push(this.record);
    }
    open = (): string => {
      this.record.opened += 1;
      return "session-open-result";
    };
  },
}));
vi.mock("../../src/tags/vaultTags", () => ({ vaultVocabulary: vi.fn(() => ({ vocab: true })) }));
vi.mock("../../src/tags/resolve", () => ({ resolveTags: vi.fn(() => [{ tag: "a" }, { tag: "b" }]) }));
vi.mock("../../src/memory/nodeReader", () => ({ nodeSessionReader: { reader: true }, defaultProjectsRoot: "/projects" }));

import { Platform, clearNotices, getNoticeMessages, normalizePath } from "obsidian";
import {
  buildClippings,
  buildEnrichment,
  buildMemory,
  buildSemantic,
  type ClippingsHost,
  type EnrichmentHost,
  type MemoryHost,
  type SemanticHost,
} from "../../src/composition/knowledge";
import { resolveTags } from "../../src/tags/resolve";
import { vaultVocabulary } from "../../src/tags/vaultTags";

function file(path: string, mtime: number, size: number): TFile {
  const f = new TFile(path, "", mtime);
  f.stat.size = size;
  return f;
}

function vaultRig() {
  const note = file("Claude/a.md", 11, 111);
  const other = file("Notes/b.md", 22, 222);
  const pdf = file("Docs/c.pdf", 33, 333);
  const byPath: Record<string, unknown> = { [note.path]: note, [other.path]: other, [pdf.path]: pdf, folder: { path: "folder" } };
  const m = {
    stat: vi.fn(async (p: string) => (p === "idx" ? { size: 77 } : null)),
    exists: vi.fn(async () => true),
    read: vi.fn(async () => "adapter-read"),
    write: vi.fn(async () => undefined),
    getMarkdownFiles: vi.fn(() => [note, other]),
    getFiles: vi.fn(() => [note, pdf]),
    getAbstractFileByPath: vi.fn((p: string) => byPath[p] ?? null),
    cachedRead: vi.fn(async () => "cached"),
    readBinary: vi.fn(async () => new ArrayBuffer(4)),
    modify: vi.fn(async () => undefined),
    create: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    getLeaf: vi.fn(),
  };
  m.getLeaf.mockReturnValue({ openFile: m.openFile });
  const app = {
    vault: {
      adapter: { stat: m.stat, exists: m.exists, read: m.read, write: m.write },
      getMarkdownFiles: m.getMarkdownFiles,
      getFiles: m.getFiles,
      getAbstractFileByPath: m.getAbstractFileByPath,
      cachedRead: m.cachedRead,
      readBinary: m.readBinary,
      modify: m.modify,
      create: m.create,
    },
    workspace: { getLeaf: m.getLeaf },
  };
  return { app, m, note, other, pdf };
}

const call = <T>(deps: Deps | undefined, name: string, ...args: unknown[]): T => (deps![name] as (...a: unknown[]) => T)(...args);

beforeEach(() => {
  captured.semantic = undefined;
  captured.enrichment = undefined;
  captured.memory = undefined;
  captured.clippings = undefined;
  captured.modals = [];
  vi.mocked(resolveTags).mockClear();
  vi.mocked(vaultVocabulary).mockClear();
  clearNotices();
});

afterEach(() => {
  Platform.isMobile = false;
  Platform.isDesktop = true;
});

function setMobile(): void {
  Platform.isMobile = true;
  Platform.isDesktop = false;
}

describe("buildSemantic", () => {
  function rig(manifest: { id: string; dir?: string }) {
    const v = vaultRig();
    const host = {
      app: v.app,
      manifest,
      settings: { s: 1 },
      activity: { a: 1 },
      enrichDiagnostics: { d: 1 },
      router: vi.fn(() => ({ r: 1 })),
      saveSettings: vi.fn(async () => undefined),
      deviceChatBusy: vi.fn(() => true),
    } as unknown as SemanticHost;
    buildSemantic(host);
    return { host, ...v };
  }

  it("falls back to the plugin folder when the manifest has no dir, else uses it", () => {
    rig({ id: "claude-companion" });
    expect(captured.semantic!.manifestDir).toBe(".obsidian/plugins/claude-companion");
    expect(captured.semantic!.manifestId).toBe("claude-companion");
    rig({ id: "claude-companion", dir: "custom/dir" });
    expect(captured.semantic!.manifestDir).toBe("custom/dir");
  });

  it("forwards host members and the mobile byte limits", async () => {
    const { host } = rig({ id: "x" });
    const d = captured.semantic!;
    expect(call(d, "settings")).toBe(host.settings);
    expect(call(d, "activity")).toBe(host.activity);
    expect(call(d, "enrichDiagnostics")).toBe(host.enrichDiagnostics);
    expect(call(d, "router")).toEqual({ r: 1 });
    await call(d, "saveSettings");
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
    expect(call(d, "deviceChatBusy")).toBe(true);
    expect(host.deviceChatBusy).toHaveBeenCalledTimes(1);
    expect(d.isMobile).toBe(Platform.isMobile);
    expect(d.mobileSourceNoteMaxBytes).toBe(5 * 1024 * 1024);
    expect(d.mobilePdfMaxBytes).toBe(10 * 1024 * 1024);
  });

  it("reads the mobile flag from the platform", () => {
    setMobile();
    rig({ id: "x" });
    expect(captured.semantic!.isMobile).toBe(true);
  });

  it("shows notices", () => {
    rig({ id: "x" });
    call(captured.semantic, "notice", "m", 5);
    expect(getNoticeMessages()).toEqual(["m"]);
  });

  it("maps the adapter lambdas to app.vault.adapter", async () => {
    const { m } = rig({ id: "x" });
    const vault = captured.semantic!.vault as unknown as Record<string, (...a: unknown[]) => unknown>;
    await expect(vault.adapterSize!("idx")).resolves.toBe(77);
    await expect(vault.adapterSize!("missing")).resolves.toBeUndefined();
    expect(m.stat).toHaveBeenCalledWith("idx");
    await expect(vault.adapterExists!("p")).resolves.toBe(true);
    expect(m.exists).toHaveBeenCalledWith("p");
    await expect(vault.adapterRead!("p")).resolves.toBe("adapter-read");
    expect(m.read).toHaveBeenCalledWith("p");
    await vault.adapterWrite!("p", "data");
    expect(m.write).toHaveBeenCalledWith("p", "data");
  });

  it("maps file listings and lookups to plain shapes", () => {
    rig({ id: "x" });
    const vault = captured.semantic!.vault as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(vault.getMarkdownFiles!()).toEqual([
      { path: "Claude/a.md", mtime: 11, size: 111 },
      { path: "Notes/b.md", mtime: 22, size: 222 },
    ]);
    expect(vault.getPdfFiles!()).toEqual([{ path: "Docs/c.pdf", mtime: 33, size: 333 }]);
    expect(vault.getAbstractFileByPath!("Claude/a.md")).toEqual({ path: "Claude/a.md", stat: { mtime: 11, size: 111 } });
    expect(vault.getAbstractFileByPath!("folder")).toBeNull();
    expect(vault.getAbstractFileByPath!("nope")).toBeNull();
  });

  it("cachedRead and readBinary read files and reject or blank non-files", async () => {
    const { m, note } = rig({ id: "x" });
    const vault = captured.semantic!.vault as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(vault.cachedRead!("Claude/a.md")).resolves.toBe("cached");
    expect(m.cachedRead).toHaveBeenCalledWith(note);
    await expect(vault.cachedRead!("folder")).resolves.toBe("");
    const buffer = await vault.readBinary!("Claude/a.md");
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(m.readBinary).toHaveBeenCalledWith(note);
    await expect(vault.readBinary!("folder")).rejects.toThrow("Not a file: folder");
    expect(m.readBinary).toHaveBeenCalledTimes(1);
  });

  it("openChoiceModal builds a ChoiceModal on the app and returns open()", () => {
    const { host } = rig({ id: "x" });
    const opts = { title: "t" };
    expect(call(captured.semantic, "openChoiceModal", opts)).toBe("choice-open-result");
    expect(captured.modals).toHaveLength(1);
    expect(captured.modals[0]).toMatchObject({ kind: "choice", opened: 1 });
    expect(captured.modals[0]!.args[0]).toBe(host.app);
    expect(captured.modals[0]!.args[1]).toBe(opts);
  });
});

describe("buildEnrichment", () => {
  function rig() {
    const v = vaultRig();
    const utility = {
      isLifecycleActive: vi.fn(() => true),
      assertLifecycleActive: vi.fn(),
      isEnded: vi.fn(() => false),
      lifecycleGeneration: vi.fn(() => 4),
    };
    const m = {
      suspendReindex: vi.fn(() => "suspended"),
      checkTagMergesInBackground: vi.fn(async () => undefined),
    };
    const host = {
      app: v.app,
      settings: { s: 1 },
      activity: { a: 1 },
      enrichDiagnostics: { d: 1 },
      router: vi.fn(() => ({ r: 1 })),
      saveSettings: vi.fn(async () => undefined),
      semantic: () => ({ suspendReindex: m.suspendReindex }),
      optimize: () => ({ checkTagMergesInBackground: m.checkTagMergesInBackground }),
      utilityRouting: () => utility,
    } as unknown as EnrichmentHost;
    buildEnrichment(host);
    return { ...v, host, utility, m, vm: v.m };
  }

  it("forwards host members", async () => {
    const { host } = rig();
    const d = captured.enrichment!;
    expect(call(d, "settings")).toBe(host.settings);
    expect(call(d, "activity")).toBe(host.activity);
    expect(call(d, "enrichDiagnostics")).toBe(host.enrichDiagnostics);
    expect(call(d, "router")).toEqual({ r: 1 });
    await call(d, "saveSettings");
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
    expect(d.enrichApp).toBe(host.app);
    expect(d.isMobile).toBe(Platform.isMobile);
    expect(d.mobileSourceNoteMaxBytes).toBe(5 * 1024 * 1024);
  });

  it("reads the mobile flag from the platform", () => {
    setMobile();
    rig();
    expect(captured.enrichment!.isMobile).toBe(true);
  });

  it("shows notices", () => {
    rig();
    call(captured.enrichment, "notice", "m", 5);
    expect(getNoticeMessages()).toEqual(["m"]);
  });

  it("resolves tags against the vault vocabulary and returns the tag names", () => {
    const { host } = rig();
    expect(call(captured.enrichment, "resolveTags", ["x", "y"])).toEqual(["a", "b"]);
    expect(vaultVocabulary).toHaveBeenCalledWith(host.app);
    expect(resolveTags).toHaveBeenCalledWith(["x", "y"], { vocab: true });
  });

  it("suspendReindex and the idle hook reach semantic and optimize", () => {
    const { m } = rig();
    expect(call(captured.enrichment, "suspendReindex")).toBe("suspended");
    expect(m.suspendReindex).toHaveBeenCalledTimes(1);
    expect(call(captured.enrichment, "onEnrichQueueIdle")).toBeUndefined();
    expect(m.checkTagMergesInBackground).toHaveBeenCalledTimes(1);
  });

  it("forwards the four lifecycle lambdas to utilityRouting with the generation", () => {
    const { utility } = rig();
    const d = captured.enrichment!;
    expect(call(d, "isUtilityLifecycleActive", 3)).toBe(true);
    expect(utility.isLifecycleActive).toHaveBeenCalledWith(3);
    call(d, "assertUtilityLifecycleActive", 5);
    expect(utility.assertLifecycleActive).toHaveBeenCalledWith(5);
    expect(call(d, "utilityLifecycleEnded")).toBe(false);
    expect(utility.isEnded).toHaveBeenCalledTimes(1);
    expect(call(d, "utilityLifecycleGeneration")).toBe(4);
    expect(utility.lifecycleGeneration).toHaveBeenCalledTimes(1);
  });

  it("openChoiceModal opens the modal and returns it", () => {
    const { host } = rig();
    const opts = { title: "t" };
    const modal = call<{ open: () => string; record: { opened: number } }>(captured.enrichment, "openChoiceModal", opts);
    expect(modal.record.opened).toBe(1);
    expect(captured.modals).toHaveLength(1);
    expect(captured.modals[0]!.args[0]).toBe(host.app);
    expect(captured.modals[0]!.args[1]).toBe(opts);
  });

  it("cachedRead reads files and blanks non-files", async () => {
    const { vm: m, note } = rig();
    const vault = captured.enrichment!.vault as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(vault.cachedRead!("Claude/a.md")).resolves.toBe("cached");
    expect(m.cachedRead).toHaveBeenCalledWith(note);
    await expect(vault.cachedRead!("folder")).resolves.toBe("");
  });
});

describe("buildMemory", () => {
  function rig() {
    const v = vaultRig();
    const m = {
      list: vi.fn(() => [{ cliSessionId: "s2", cliSessionHistory: ["s1"] }, { cliSessionId: "s3" }, {}]),
      getActive: vi.fn(() => ({ id: "active" })),
      refreshMemoryView: vi.fn(),
      vaultBasePath: vi.fn(() => "/vault"),
    };
    const host = {
      app: v.app,
      settings: { s: 1 },
      router: vi.fn(() => ({ r: 1 })),
      vaultBasePath: m.vaultBasePath,
      conversations: () => ({ list: m.list, getActive: m.getActive }),
      views: () => ({ refreshMemoryView: m.refreshMemoryView }),
    } as unknown as MemoryHost;
    buildMemory(host);
    return { ...v, host, m, vm: v.m };
  }

  it("forwards host members", () => {
    const { host, m } = rig();
    const d = captured.memory!;
    expect(call(d, "settings")).toBe(host.settings);
    expect(call(d, "router")).toEqual({ r: 1 });
    expect(call(d, "vaultBasePath")).toBe("/vault");
    expect(m.vaultBasePath).toHaveBeenCalledTimes(1);
    expect(d.ingestApp).toBe(host.app);
    expect(d.isMobile).toBe(Platform.isMobile);
    expect(d.normalizePath).toBe(normalizePath);
    call(d, "refreshMemoryView");
    expect(m.refreshMemoryView).toHaveBeenCalledTimes(1);
  });

  it("reads the mobile flag from the platform", () => {
    setMobile();
    rig();
    expect(captured.memory!.isMobile).toBe(true);
  });

  it("shows notices", () => {
    rig();
    call(captured.memory, "notice", "m", 5);
    expect(getNoticeMessages()).toEqual(["m"]);
  });

  it("flat-maps CLI session ids over the conversations and forwards the active one", () => {
    const { m } = rig();
    expect(call(captured.memory, "excludedSessionIds")).toEqual(["s1", "s2", "s3"]);
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(call(captured.memory, "getActiveConversation")).toEqual({ id: "active" });
    expect(m.getActive).toHaveBeenCalledTimes(1);
  });

  it("markdownFilesUnder keeps paths under the prefix folder", () => {
    rig();
    const vault = captured.memory!.vault as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(vault.markdownFilesUnder!("Claude")).toEqual([{ path: "Claude/a.md", mtime: 11 }]);
    expect(vault.markdownFilesUnder!("Cla")).toEqual([]);
  });

  it("readContent returns the cached text for a file and null otherwise", async () => {
    const { vm: m, note } = rig();
    const vault = captured.memory!.vault as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(vault.readContent!("Claude/a.md")).resolves.toBe("cached");
    expect(m.cachedRead).toHaveBeenCalledWith(note);
    await expect(vault.readContent!("folder")).resolves.toBeNull();
  });

  it("writeContent modifies an existing file and creates otherwise", async () => {
    const { vm: m, note } = rig();
    const vault = captured.memory!.vault as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await vault.writeContent!("Claude/a.md", "new");
    expect(m.modify).toHaveBeenCalledWith(note, "new");
    expect(m.create).not.toHaveBeenCalled();
    await vault.writeContent!("Claude/fresh.md", "body");
    expect(m.create).toHaveBeenCalledWith("Claude/fresh.md", "body");
    expect(m.modify).toHaveBeenCalledTimes(1);
  });

  it("openFile opens a file in the current leaf and ignores non-files", async () => {
    const { vm: m, note } = rig();
    await call<Promise<void>>(captured.memory, "openFile", "Claude/a.md");
    expect(m.getLeaf).toHaveBeenCalledWith(false);
    expect(m.openFile).toHaveBeenCalledWith(note);
    m.openFile.mockClear();
    await call<Promise<void>>(captured.memory, "openFile", "folder");
    expect(m.openFile).not.toHaveBeenCalled();
  });

  it("openSessionPicker builds a SessionPicker on the app and returns open()", () => {
    const { host } = rig();
    const sessions = [{ id: "s" }];
    const onPick = vi.fn();
    expect(call(captured.memory, "openSessionPicker", sessions, onPick)).toBe("session-open-result");
    expect(captured.modals).toHaveLength(1);
    expect(captured.modals[0]).toMatchObject({ kind: "session", opened: 1 });
    expect(captured.modals[0]!.args[0]).toBe(host.app);
    expect(captured.modals[0]!.args[1]).toBe(sessions);
    expect(captured.modals[0]!.args[2]).toBe(onPick);
  });

  it("nodeSessionReader resolves the reader and projects root from the node module", async () => {
    rig();
    await expect(call<Promise<unknown>>(captured.memory, "nodeSessionReader")).resolves.toEqual({
      reader: { reader: true },
      defaultProjectsRoot: "/projects",
    });
  });
});

describe("buildClippings", () => {
  it("forwards host members, enrichment and the utility error hint", () => {
    const enrichment = { e: 1 };
    const providerErrorHint = vi.fn(() => "hint");
    const host = {
      app: { app: true },
      settings: { s: 1 },
      activity: { a: 1 },
      enrichDiagnostics: { d: 1 },
      router: vi.fn(() => ({ r: 1 })),
      enrichment: vi.fn(() => enrichment),
      utilityRouting: () => ({ providerErrorHint }),
    } as unknown as ClippingsHost;
    buildClippings(host);
    const d = captured.clippings!;
    expect(d.app).toBe(host.app);
    expect(call(d, "settings")).toBe(host.settings);
    expect(call(d, "activity")).toBe(host.activity);
    expect(call(d, "router")).toEqual({ r: 1 });
    expect(call(d, "enrichment")).toBe(enrichment);
    expect(host.enrichment).toHaveBeenCalledTimes(1);
    expect(call(d, "diagnostics")).toBe(host.enrichDiagnostics);
    expect(call(d, "providerErrorHint", "boom", "ollama")).toBe("hint");
    expect(providerErrorHint).toHaveBeenCalledWith("boom", "ollama");
  });
});
