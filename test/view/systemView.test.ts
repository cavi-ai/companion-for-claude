import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import ClaudeCompanionPlugin from "../../src/main";
import { SystemView, type SystemViewDeps } from "../../src/view/SystemView";
import type { HealthReport, HealthSection } from "../../src/health/scan";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const section = (over: Partial<HealthSection> & Pick<HealthSection, "id">): HealthSection => ({
  group: "vault", title: over.id, count: 0, severity: "ok", items: [], ...over,
});

function harness(sections: HealthSection[]): { view: SystemView; deps: SystemViewDeps; scan: ReturnType<typeof vi.fn> } {
  const app = new App();
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin, { app, settings: {} });
  const scan = vi.fn(async (): Promise<HealthReport> => ({ sections, scannedAt: "2026-10-01T00:00:00.000Z" }));
  const deps: SystemViewDeps = {
    scan,
    safeFixes: vi.fn(() => []),
    openNote: vi.fn(),
    openResearchDesk: vi.fn(async () => undefined),
    buildIndex: vi.fn(async () => undefined),
    catchUpIndex: vi.fn(async () => undefined),
    openInbox: vi.fn(async () => undefined),
    reviewSafeFixes: vi.fn(),
    reviewTagMerges: vi.fn(),
    connectOrphans: vi.fn(),
    openSetupWizard: vi.fn(),
    openSettings: vi.fn(),
    openClipperSetup: vi.fn(),
    runActivityRecovery: vi.fn(),
  };
  return { view: new SystemView(new WorkspaceLeaf(app), plugin, deps), deps, scan };
}

const root = (view: SystemView): FakeElement => view.contentEl as unknown as FakeElement;
const text = (el: FakeElement): string => el.textContent + el.children.map(text).join(" ");
const click = (el: FakeElement | null | undefined): void => {
  expect(el).toBeTruthy();
  el!.dispatchEvent({ type: "click" });
};
const button = (view: SystemView, text: string): FakeElement =>
  root(view).querySelectorAll("button").find((b) => b.textContent === text)!;

describe("SystemView more footer", () => {
  it("is absent for the orphans and tags summary sections and kept for an itemized section", async () => {
    const { view } = harness([
      section({ id: "orphans", count: 4, severity: "info", summary: true, items: [{ path: "", message: "4 notes with no links" }] }),
      section({ id: "tags", count: 4, severity: "info", summary: true, items: [{ path: "", message: "4 merge candidates" }] }),
      section({ id: "links", count: 4, severity: "warning", items: [{ path: "a.md", message: "1 broken link: X" }] }),
    ]);
    await view.onOpen();
    const card = (id: string): FakeElement => root(view).querySelector(`.cc-system-${id}`)!;
    expect(card("orphans").querySelector(".cc-system-more")).toBeNull();
    expect(card("tags").querySelector(".cc-system-more")).toBeNull();
    expect(card("links").querySelector(".cc-system-more")?.textContent).toBe("+3 more");
  });
});

describe("SystemView", () => {
  const companion =(over: Partial<HealthSection> & Pick<HealthSection, "id">): HealthSection => section({ group: "companion", ...over });

  it("renders COMPANION and VAULT groups", async () => {
    const { view } = harness([
      companion({ id: "connection", title: "Connection", count: 1, severity: "error", items: [{ path: "", message: "no credential" }] }),
      section({ id: "links", title: "Broken links", count: 1, severity: "warning", items: [{ path: "a.md", message: "1 broken link: X" }] }),
    ]);
    await view.onOpen();
    expect(root(view).querySelectorAll(".cc-system-group").map((g) => g.textContent)).toEqual(["COMPANION", "VAULT"]);
    expect(root(view).querySelector(".cc-system-connection")).not.toBeNull();
    expect(root(view).querySelector(".cc-system-links")).not.toBeNull();
  });

  it("ok group says All good.", async () => {
    const { view } = harness([
      companion({ id: "connection", title: "Connection" }),
      section({ id: "links", title: "Broken links", count: 1, severity: "warning", items: [{ path: "a.md", message: "m" }] }),
    ]);
    await view.onOpen();
    expect(root(view).querySelectorAll(".cc-system-group-ok").map((g) => g.textContent)).toEqual(["All good."]);
  });

  it("every action id dispatches", async () => {
    const { view, deps } = harness([
      companion({ id: "connection", title: "Connection", count: 1, severity: "error", items: [{ path: "", message: "x" }], actions: [{ id: "open-setup-wizard", label: "Open setup wizard" }] }),
      companion({ id: "bridge", title: "MCP bridge", count: 1, severity: "error", items: [{ path: "", message: "x" }], actions: [{ id: "open-settings", label: "Open settings · Agent → Agent bridge" }] }),
      companion({ id: "clipper", title: "Web Clipper", count: 1, severity: "info", items: [{ path: "", message: "x" }], actions: [{ id: "clipper-schemas", label: "Set up Web Clipper" }] }),
    ]);
    await view.onOpen();
    click(button(view, "Open setup wizard"));
    expect(deps.openSetupWizard).toHaveBeenCalledTimes(1);
    click(button(view, "Open settings · Agent → Agent bridge"));
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
    click(button(view, "Set up Web Clipper"));
    expect(deps.openClipperSetup).toHaveBeenCalledTimes(1);
  });

  it("open-note action opens the note at its path", async () => {
    const { view, deps } = harness([
      companion({ id: "orders", title: "Standing orders", count: 1, severity: "warning", items: [{ path: "Claude/Templates/Daily.md", message: "bad" }], actions: [{ id: "open-note", label: "Open Daily", path: "Claude/Templates/Daily.md" }] }),
    ]);
    await view.onOpen();
    click(button(view, "Open Daily"));
    expect(deps.openNote).toHaveBeenCalledWith("Claude/Templates/Daily.md");
  });

  it("activity action passes activityId", async () => {
    const { view, deps } = harness([
      companion({ id: "activity", title: "Background work", count: 1, severity: "warning", items: [{ path: "", message: "x — 1 failed" }], actions: [{ id: "retry-index", label: "Retry", activityId: "a1" }] }),
    ]);
    await view.onOpen();
    click(button(view, "Retry"));
    expect(deps.runActivityRecovery).toHaveBeenCalledWith("a1", "retry-index");
  });

  it("footer opens settings", async () => {
    const { view, deps } = harness([section({ id: "links", title: "Broken links", count: 1, severity: "warning", items: [] })]);
    await view.onOpen();
    click(root(view).querySelector(".cc-system-settings"));
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  it("renders non-ok sections with counts", async () => {
    const { view } = harness([
      section({ id: "links", title: "Broken links", count: 3, severity: "warning", items: [{ path: "a.md", message: "3 broken links: X" }] }),
      section({ id: "ontology", title: "Ontology" }),
    ]);
    await view.onOpen();
    expect(text(root(view).querySelector(".cc-system-links")!)).toContain("Broken links · 3");
    expect(root(view).querySelector(".cc-system-ontology")).toBeNull();
  });

  it("row click opens the note", async () => {
    const { view, deps } = harness([
      section({ id: "links", title: "Broken links", count: 1, severity: "warning", items: [{ path: "a.md", message: "1 broken link: X" }] }),
    ]);
    await view.onOpen();
    click(root(view).querySelector(".cc-system-link"));
    expect(deps.openNote).toHaveBeenCalledWith("a.md");
  });

  it("summary rows are not links", async () => {
    const { view } = harness([
      section({ id: "inbox", title: "Inbox", count: 2, severity: "info", items: [{ path: "", message: "2 clips waiting to be enriched" }] }),
    ]);
    await view.onOpen();
    expect(root(view).querySelector(".cc-system-inbox")).not.toBeNull();
    expect(root(view).querySelector(".cc-system-inbox")!.querySelector(".cc-system-link")).toBeNull();
  });

  it("Refresh rescans", async () => {
    const { view, scan } = harness([section({ id: "inbox", title: "Inbox", count: 1, severity: "info", items: [{ path: "", message: "x" }] })]);
    await view.onOpen();
    click(root(view).querySelector(".cc-system-refresh"));
    await settle();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("actions call their deps", async () => {
    const { view, deps } = harness([
      section({ id: "ontology", title: "Ontology", count: 2, severity: "warning", fixable: 2, items: [{ path: "a.md", message: "m" }] }),
      section({ id: "index", title: "Semantic index", count: 1, severity: "info", items: [{ path: "", message: "Semantic index not built yet" }] }),
      section({ id: "inbox", title: "Inbox", count: 1, severity: "info", items: [{ path: "", message: "1 clip waiting to be enriched" }] }),
      section({ id: "research", title: "Research", count: 1, severity: "warning", items: [{ path: "P/e.md", message: "x", project: "P/Project.md" }] }),
    ]);
    await view.onOpen();
    click(button(view, "Review safe fixes (2)"));
    expect(deps.reviewSafeFixes).toHaveBeenCalledTimes(1);
    click(button(view, "Build index"));
    await settle();
    expect(deps.buildIndex).toHaveBeenCalledTimes(1);
    click(button(view, "Open Inbox"));
    expect(deps.openInbox).toHaveBeenCalledTimes(1);
    click(button(view, "Open in Research Desk"));
    expect(deps.openResearchDesk).toHaveBeenCalledWith("P/Project.md");
  });

  it("says everything checks out when all sections are ok", async () => {
    const { view } = harness([section({ id: "links", title: "Broken links" }), section({ id: "inbox", title: "Inbox" })]);
    await view.onOpen();
    expect(root(view).querySelector(".cc-system-ok")?.textContent).toBe("Everything checks out.");
  });

  it("a slow scan never paints over a newer one", async () => {
    const { view, scan } = harness([]);
    let release: (r: HealthReport) => void = () => undefined;
    scan.mockImplementationOnce(() => new Promise<HealthReport>((resolve) => { release = resolve; }));
    const first = view.render();
    await view.render();
    release({ sections: [section({ id: "links", title: "Broken links", count: 9, severity: "warning", items: [] })], scannedAt: "2026-10-01T00:00:00.000Z" });
    await first;
    expect(root(view).querySelector(".cc-system-links")).toBeNull();
  });

  it("orphans section offers Connect orphan notes only when there are orphans, and refreshes after", async () => {
    const some = harness([section({ id: "orphans", title: "Orphan notes", count: 4, severity: "info", items: [{ path: "", message: "4 notes with no links" }] })]);
    await some.view.onOpen();
    click(button(some.view, "Connect orphan notes"));
    expect(some.deps.connectOrphans).toHaveBeenCalledTimes(1);
    (some.deps.connectOrphans as ReturnType<typeof vi.fn>).mock.calls[0]![0]();
    await settle();
    expect(some.scan).toHaveBeenCalledTimes(2);

    const none = harness([section({ id: "orphans", title: "Orphan notes", count: 0 })]);
    await none.view.onOpen();
    expect(root(none.view).querySelectorAll("button").find((b) => b.textContent === "Connect orphan notes")).toBeUndefined();
  });

  it("tags section offers Review tag merges only when there are candidates, and refreshes after", async () => {
    const withCandidates = harness([section({ id: "tags", title: "Tags", count: 2, severity: "info", items: [{ path: "", message: "2 merge candidates by name · 1 of 5 tags used once" }] })]);
    await withCandidates.view.onOpen();
    click(button(withCandidates.view, "Review tag merges"));
    expect(withCandidates.deps.reviewTagMerges).toHaveBeenCalledTimes(1);
    const done = (withCandidates.deps.reviewTagMerges as ReturnType<typeof vi.fn>).mock.calls[0]![0] as () => void;
    done();
    await settle();
    expect(withCandidates.scan).toHaveBeenCalledTimes(2);

    const none = harness([section({ id: "tags", title: "Tags", count: 0 })]);
    await none.view.onOpen();
    expect(root(none.view).querySelectorAll("button").find((b) => b.textContent === "Review tag merges")).toBeUndefined();
  });
});
