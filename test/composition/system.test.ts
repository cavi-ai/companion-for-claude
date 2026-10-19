import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

const captured = vi.hoisted(() => ({
  health: undefined as Record<string, (...args: never[]) => unknown> | undefined,
  modal: undefined as unknown[] | undefined,
  scan: undefined as unknown,
  safeFixes: undefined as unknown,
}));

vi.mock("../../src/health/controller", () => ({
  HealthController: class {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.health = deps;
    }
    scan = (): unknown => captured.scan;
    safeFixes = (): unknown => captured.safeFixes;
  },
}));
vi.mock("../../src/view/SafeFixModal", () => ({
  SafeFixModal: class {
    constructor(...args: unknown[]) {
      captured.modal = args;
    }
    open = vi.fn();
  },
}));
vi.mock("../../src/vault/vaultFiles", () => ({ lookupRelationTargetType: vi.fn(() => "Type") }));
vi.mock("../../src/optimize/vaultGlue", () => ({ linkScanNotes: vi.fn(() => ["notes"]) }));
vi.mock("../../src/optimize/linkScan", () => ({ findOrphans: vi.fn(() => ["o1", "o2"]) }));
vi.mock("../../src/research/audit", () => ({ auditProject: vi.fn((snapshot: unknown) => ({ audited: snapshot })) }));
vi.mock("../../src/providers/setupState", () => ({ needsCredentialSetup: vi.fn(() => true) }));

import { buildHealthController, buildSystemDeps, type SystemHost } from "../../src/composition/system";
import { lookupRelationTargetType } from "../../src/vault/vaultFiles";
import { linkScanNotes } from "../../src/optimize/vaultGlue";
import { findOrphans } from "../../src/optimize/linkScan";
import { needsCredentialSetup } from "../../src/providers/setupState";

function rig(over: { runActivityRecovery?: boolean } = {}) {
  const m = {
    openLinkText: vi.fn(),
    activateResearchDesk: vi.fn(async () => undefined),
    rebuildSemanticIndex: vi.fn(async () => undefined),
    catchUpIndex: vi.fn(async () => undefined),
    activateInboxView: vi.fn(async () => undefined),
    openSetupWizard: vi.fn(),
    openCompanionSettings: vi.fn(),
    openClipperSetup: vi.fn(),
    reviewTagMerges: vi.fn(),
    reviewOrphanLinks: vi.fn(),
    reviewUntypedNotes: vi.fn(),
    run: vi.fn(),
    runActivityRecovery: vi.fn(),
    processFrontMatter: vi.fn(async (_file: unknown, cb: (fm: Record<string, unknown>) => void) => cb({})),
    getFileByPath: vi.fn(() => ({ path: "a.md" })),
    listProjects: vi.fn(async () => ["p"]),
    loadProject: vi.fn(async () => ({ project: true })),
    stats: vi.fn(async () => ({ notes: 3 })),
    tagsScan: vi.fn(async () => ({ totalTags: 9, singleUse: 4, candidates: [1, 2] })),
    typesScan: vi.fn(async () => ({ status: "ok", candidates: 5 })),
    invalidOrders: vi.fn(() => [{ path: "o.md", reason: "bad" }]),
    ontology: { id: "registry" },
    records: [
      { id: "idx-old", kind: "semantic-index", state: "needs-attention", updatedAt: 1, title: "Old", failed: 0, recovery: [], details: [{ label: "old.md", message: "old" }] },
      { id: "idx-new", kind: "semantic-index", state: "needs-attention", updatedAt: 2, title: "New", failed: 0, recovery: [], details: [{ label: "new.md", message: "new" }] },
      { id: "a1", kind: "other", state: "needs-attention", title: "T", failed: 1, updatedAt: 3, recovery: [{ id: "r", label: "Retry", extra: 1 }] },
      { id: "a2", kind: "other", state: "idle", title: "ignored", failed: 0, updatedAt: 4, recovery: [] },
    ],
  };
  const host = {
    app: {
      vault: { getMarkdownFiles: () => [{ path: "a.md" }] },
      metadataCache: { getFileCache: () => ({ frontmatter: { type: "x" } }), unresolvedLinks: { "a.md": { b: 1 } }, resolvedLinks: { "a.md": {} } },
      workspace: { openLinkText: m.openLinkText },
      fileManager: { processFrontMatter: m.processFrontMatter },
    },
    settings: { semanticEnabled: true, ontologyFolder: "Ont", mcpEnabled: true, mcpPort: 1234, sourceCaptureEnabled: true },
    activity: { snapshot: () => ({ records: m.records }) },
    onboarding: () => ({ credentialSetupInputs: () => ({ inputs: true }), openSetupWizard: m.openSetupWizard }),
    views: () => ({ inboxPendingCount: () => 7, activateInboxView: m.activateInboxView }),
    mcpRunning: () => true,
    clipperSetup: () => ({ status: () => "current", openSetup: m.openClipperSetup }),
    ontology: () => m.ontology,
    optimize: () => ({
      tags: () => ({ scan: m.tagsScan }),
      types: () => ({ scan: m.typesScan }),
      reviewTagMerges: m.reviewTagMerges,
      reviewOrphanLinks: m.reviewOrphanLinks,
      reviewUntypedNotes: m.reviewUntypedNotes,
    }),
    research: () => ({
      researchRepository: () => ({ listProjects: m.listProjects, loadProject: m.loadProject }),
      activateResearchDesk: m.activateResearchDesk,
    }),
    router: () => ({ chatBackend: "claude" }),
    semantic: () => ({ indexer: () => ({ stats: m.stats }), rebuildSemanticIndex: m.rebuildSemanticIndex, catchUpIndex: m.catchUpIndex }),
    standingOrders: () => ({ invalidOrders: m.invalidOrders }),
    shell: () => ({
      companionChrome: () => ({ run: m.run, ...(over.runActivityRecovery ? { runActivityRecovery: m.runActivityRecovery } : {}) }),
      openCompanionSettings: m.openCompanionSettings,
    }),
  } as unknown as SystemHost;
  m.getFileByPath.mockReturnValue({ path: "a.md" });
  (host.app.vault as unknown as Record<string, unknown>).getFileByPath = m.getFileByPath;
  return { host, m };
}

const health = (): Record<string, (...args: never[]) => unknown> => captured.health!;
const call = (name: string, ...args: unknown[]): unknown => (health()[name] as (...a: unknown[]) => unknown)(...args);

beforeEach(() => {
  captured.health = undefined;
  captured.modal = undefined;
  captured.scan = Promise.resolve("scan-result");
  captured.safeFixes = ["fix"];
});

describe("buildSystemDeps", () => {
  it("scan and safeFixes come from the health controller", async () => {
    const { host } = rig();
    const deps = buildSystemDeps(host);
    await expect(deps.scan()).resolves.toBe("scan-result");
    expect(deps.safeFixes()).toEqual(["fix"]);
  });

  it("each action reaches its host member", async () => {
    const { host, m } = rig();
    const deps = buildSystemDeps(host);
    deps.openNote("a.md");
    expect(m.openLinkText).toHaveBeenCalledWith("a.md", "");
    await deps.openResearchDesk("proj");
    expect(m.activateResearchDesk).toHaveBeenCalledWith("proj");
    await deps.buildIndex();
    expect(m.rebuildSemanticIndex).toHaveBeenCalledTimes(1);
    await deps.catchUpIndex();
    expect(m.catchUpIndex).toHaveBeenCalledTimes(1);
    await deps.openInbox();
    expect(m.activateInboxView).toHaveBeenCalledTimes(1);
    deps.openSetupWizard();
    expect(m.openSetupWizard).toHaveBeenCalledTimes(1);
    deps.openSettings();
    expect(m.openCompanionSettings).toHaveBeenCalledTimes(1);
    deps.openClipperSetup();
    expect(m.openClipperSetup).toHaveBeenCalledTimes(1);
  });

  it("routes each optimize review to its own method with the done callback", () => {
    const { host, m } = rig();
    const deps = buildSystemDeps(host);
    const done = vi.fn();
    deps.reviewTagMerges(done);
    expect(m.reviewTagMerges).toHaveBeenCalledWith(done);
    deps.connectOrphans(done);
    expect(m.reviewOrphanLinks).toHaveBeenCalledWith(done);
    deps.typeUntypedNotes(done);
    expect(m.reviewUntypedNotes).toHaveBeenCalledWith(done);
    expect(m.reviewTagMerges).toHaveBeenCalledTimes(1);
    expect(m.reviewOrphanLinks).toHaveBeenCalledTimes(1);
    expect(m.reviewUntypedNotes).toHaveBeenCalledTimes(1);
  });

  it("recovery prefers the chrome's runner and falls back to run", () => {
    const withRunner = rig({ runActivityRecovery: true });
    buildSystemDeps(withRunner.host).runActivityRecovery("act", "retry");
    expect(withRunner.m.runActivityRecovery).toHaveBeenCalledWith("act", "retry");
    expect(withRunner.m.run).not.toHaveBeenCalled();

    const fallback = rig();
    buildSystemDeps(fallback.host).runActivityRecovery("act", "retry");
    expect(fallback.m.run).toHaveBeenCalledWith({ id: "retry", page: "system", activityId: "act" });
  });

  it("safe-fix review writes the patch through processFrontMatter and reports done", async () => {
    const { host, m } = rig();
    const done = vi.fn();
    buildSystemDeps(host).reviewSafeFixes(["fix"] as never, done);
    const [app, fixes, write, onDone] = captured.modal as [unknown, unknown, (fix: import("../../src/health/controller").SafeFix) => Promise<void>, () => void];
    expect(app).toBe(host.app);
    expect(fixes).toEqual(["fix"]);
    const fm: Record<string, unknown> = { type: "tagged", aliases: "solo", keep: 1 };
    m.processFrontMatter.mockImplementationOnce(async (_f, cb) => cb(fm));
    const fix = { path: "a.md", changes: [{ key: "aliases", from: "solo", to: ["solo"] }], fixed: { type: "tagged", aliases: ["solo"] } };
    await write(fix);
    expect(m.getFileByPath).toHaveBeenCalledWith("a.md");
    expect(fm).toEqual({ keep: 1, type: "tagged", aliases: ["solo"] });
    m.getFileByPath.mockReturnValueOnce(null as never);
    m.processFrontMatter.mockClear();
    await expect(write({ ...fix, path: "gone.md" })).rejects.toThrow("no longer exists");
    expect(m.processFrontMatter).not.toHaveBeenCalled();
    onDone();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it.each(["aliases", "type"])("rejects an outdated safe fix when %s changes inside the write", async (changed) => {
    const { host, m } = rig();
    buildSystemDeps(host).reviewSafeFixes([], () => {});
    const write = captured.modal![2] as (fix: import("../../src/health/controller").SafeFix) => Promise<void>;
    const fm = { type: changed === "type" ? "other" : "tagged", aliases: changed === "aliases" ? ["new-choice"] : "solo", keep: true };
    const before = JSON.stringify(fm);
    m.processFrontMatter.mockImplementationOnce(async (_f, cb) => cb(fm));
    await expect(write({ path: "a.md", changes: [{ key: "aliases", from: "solo", to: ["solo"] }], fixed: { type: "tagged", aliases: ["solo"] } })).rejects.toThrow("changed since review");
    expect(JSON.stringify(fm)).toBe(before);
  });

  it("validates every reviewed property before applying any of them", async () => {
    const { host, m } = rig();
    buildSystemDeps(host).reviewSafeFixes([], () => {});
    const write = captured.modal![2] as (fix: import("../../src/health/controller").SafeFix) => Promise<void>;
    const fm = { type: "tagged", aliases: "solo", score: "2" };
    m.processFrontMatter.mockImplementationOnce(async (_f, cb) => cb(fm));
    await expect(write({ path: "a.md", changes: [{ key: "aliases", from: "solo", to: ["solo"] }, { key: "score", from: "1", to: 1 }], fixed: { type: "tagged", aliases: ["solo"], score: 1 } })).rejects.toThrow("changed since review");
    expect(fm).toEqual({ type: "tagged", aliases: "solo", score: "2" });
  });
});

describe("buildHealthController", () => {
  it("maps vault readers", async () => {
    const { host, m } = rig();
    buildHealthController(host);
    expect(call("markdownFiles")).toEqual([{ path: "a.md", frontmatter: { type: "x" } }]);
    expect(call("unresolvedLinks")).toEqual({ "a.md": { b: 1 } });
    expect(call("ontology")).toBe(m.ontology);
    expect(call("lookupTargetType", "T")).toBe("Type");
    expect(lookupRelationTargetType).toHaveBeenCalledWith(host.app, m.ontology, "T");
    expect(call("orphanCount")).toBe(2);
    expect(linkScanNotes).toHaveBeenCalledWith(host.app, m.ontology);
    expect(findOrphans).toHaveBeenCalledWith(["notes"], { "a.md": {} }, "Ont");
    expect(call("inboxPending")).toBe(7);
    expect(call("now")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("maps research projects and audits", async () => {
    const { host, m } = rig();
    buildHealthController(host);
    await expect(call("listProjects")).resolves.toEqual(["p"]);
    await expect(call("auditProject", "proj")).resolves.toEqual({ audited: { project: true } });
    expect(m.loadProject).toHaveBeenCalledWith("proj");
  });

  it("maps the index, tag and type scans", async () => {
    const { host, m } = rig();
    buildHealthController(host);
    await expect(call("index")).resolves.toEqual({ enabled: true, built: true, failed: [{ path: "new.md", message: "new" }] });
    await expect(call("tags")).resolves.toEqual({ total: 9, singleUse: 4, candidates: 2 });
    expect(m.tagsScan).toHaveBeenCalledWith({ semantic: false });
    await expect(call("untypedCount")).resolves.toBe(5);
    m.typesScan.mockResolvedValueOnce({ status: "off", candidates: 0 } as never);
    await expect(call("untypedCount")).resolves.toBeNull();
  });

  it("companion aggregates connection, activity, bridge, clipper and orders", () => {
    const { host } = rig();
    buildHealthController(host);
    expect(needsCredentialSetup).not.toHaveBeenCalled();
    expect(call("companion")).toEqual({
      connection: { backend: "claude", needsCredential: true },
      activity: [
        { id: "idx-old", title: "Old", failed: 0, recovery: [] },
        { id: "idx-new", title: "New", failed: 0, recovery: [] },
        { id: "a1", title: "T", failed: 1, recovery: [{ id: "r", label: "Retry" }] },
      ],
      bridge: { applicable: !Platform.isMobile, enabled: true, running: true, port: 1234 },
      clipper: { applicable: true, status: "current" },
      orders: { invalid: [{ path: "o.md", reason: "bad" }] },
    });
    expect(needsCredentialSetup).toHaveBeenCalledWith({ inputs: true });
  });
});
