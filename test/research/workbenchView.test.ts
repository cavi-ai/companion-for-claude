import { describe, expect, it, vi } from "vitest";
import { getLastOpenedModal, WorkspaceLeaf } from "obsidian";
import type { ResearchRepository } from "../../src/research/repository";
import { RESEARCH_WORKBENCH_VIEW_TYPE, ResearchWorkbenchView, replaceResearchProjectPath } from "../../src/view/ResearchWorkbenchView";
import { parseDraftSections, renderDraftSection } from "../../src/research/draftSections";
import { ResearchDraftPanel, safeDraftError } from "../../src/view/ResearchDraftPanel";
import { buildDraftGrounding, groundingClaimFingerprint } from "../../src/research/draftGrounding";

const snapshot = {
  project: { path: "Research/P/Project.md", title: "Project P", question: "Why?", stage: "reason", status: "active" },
  sources: [{ path: "Research/P/Sources/S.md", title: "Source S" }], evidence: [], claims: [], questions: [], documents: [], issues: [],
  health: { claimCount: 0, trustedSupportCount: 0, supportedClaimCount: 0 },
};

function elements(view: ResearchWorkbenchView, selector: string): any[] { return [...view.contentEl.querySelectorAll(selector)]; }
function click(element: any): void { element.dispatchEvent({ type: "click" }); }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function intelligenceDependencies(overrides: Record<string, unknown> = {}) {
  let analyzeCalls = 0;
  let cancelCalls = 0;
  return {
    dependencies: {
      narratorMode: () => "current" as const,
      coordinator: {
        stateFor: () => ({ status: "not-analyzed" as const }),
        analyze: async () => { analyzeCalls += 1; return { status: "not-analyzed" as const }; },
        cancel: () => { cancelCalls += 1; },
        subscribe: () => () => undefined,
        ...overrides,
      } as never,
    },
    get analyzeCalls() { return analyzeCalls; },
    get cancelCalls() { return cancelCalls; },
  };
}

function discoveryCoordinator(overrides: Record<string, unknown> = {}) {
  return {
    stateFor: () => ({ status: "idle", query: { text: "Why?", projectPath: snapshot.project.path } }),
    subscribe: () => () => undefined, search: vi.fn(), expand: vi.fn(), rerank: vi.fn(), importCandidates: vi.fn(), dismiss: vi.fn(), cancel: vi.fn(),
    ...overrides,
  } as never;
}

describe("ResearchWorkbenchView", () => {
  it("redacts provider credentials from section drafting errors", () => {
    expect(safeDraftError(new Error("request failed\nBearer secret-token api_key=also-secret"))).toBe("request failed [redacted] [redacted]");
  });
  it("registers stable accessible view metadata", () => {
    const repository = { loadProject: () => Promise.reject(new Error("unused")) } as ResearchRepository;
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), repository);
    expect(view.getViewType()).toBe(RESEARCH_WORKBENCH_VIEW_TYPE);
    expect(view.getDisplayText()).toBe("Research workbench");
    expect(view.getIcon()).toBe("microscope");
  });

  it("normalizes a child record project link before loading", async () => {
    const loaded: string[] = [];
    const repository = { loadProject: (path: string) => { loaded.push(path); return Promise.reject(new Error("stop after routing")); } } as ResearchRepository;
    class RoutingView extends ResearchWorkbenchView {
      override async render(): Promise<void> {
        const path = this.getProjectPath();
        if (path) await repository.loadProject(path).catch(() => undefined);
      }
    }
    const view = new RoutingView(new WorkspaceLeaf(), repository);
    await view.setProjectPath("[[Research/Alpha/Project.md|Alpha]]");
    expect(loaded).toEqual(["Research/Alpha/Project.md"]);
  });

  it("renders distinct empty, loaded, and sanitized load-error states", async () => {
    const empty = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await empty.render();
    expect(elements(empty, "h3").map(({ textContent }) => textContent)).toContain("No research project selected");

    const loaded = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await loaded.setProjectPath(snapshot.project.path);
    expect(elements(loaded, "h2").map(({ textContent }) => textContent)).toContain("Project P");
    expect(elements(loaded, ".cc-research-health-metric")).toHaveLength(4);
    expect(elements(loaded, ".cc-research-actions")[0]?.children.map(({ textContent }: any) => textContent)).toEqual(expect.arrayContaining(["Create project", "Add source", "Run audit"]));

    const broken = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => { throw new Error("bad\nsecret\tmetadata Bearer token-value"); } } as never);
    await broken.setProjectPath(snapshot.project.path);
    expect(elements(broken, ".cc-research-project-path")[0]?.textContent).toBe(snapshot.project.path);
    expect(elements(broken, ".cc-research-error")[0]?.textContent).toBe("bad secret metadata [redacted]");
    expect(elements(broken, "h3").map(({ textContent }) => textContent)).not.toContain("No research project selected");
    expect(elements(broken, "button").map(({ textContent }) => textContent)).toContain("Run audit");
  });

  it("returns to the desk or asks Companion without losing project context", async () => {
    const openDesk = vi.fn(async () => undefined);
    const askCompanion = vi.fn(async () => undefined);
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never, {
      ...intelligenceDependencies().dependencies,
      openDesk,
      askCompanion,
    });
    await view.setProjectPath(snapshot.project.path);
    expect(elements(view, ".cc-research-header-top")).toHaveLength(1);
    expect(elements(view, ".cc-workspace-navigation")).toHaveLength(1);
    click(elements(view, "button").find(({ textContent }) => textContent === "Research Desk"));
    click(elements(view, "button").find(({ textContent }) => textContent === "Ask Companion"));
    await Promise.resolve();
    expect(openDesk).toHaveBeenCalledWith(snapshot.project.path);
    expect(askCompanion).toHaveBeenCalledWith(snapshot.project.path);
  });

  it("implements linked tabpanels, roving tabindex, and keyboard tab navigation", async () => {
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await view.setProjectPath(snapshot.project.path);
    let tabs = elements(view, '[role="tab"]');
    expect(tabs).toHaveLength(9);
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs.slice(1).every((tab) => tab.getAttribute("tabindex") === "-1")).toBe(true);
    const panel = elements(view, '[role="tabpanel"]')[0];
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].getAttribute("id"));
    tabs[0].dispatchEvent({ type: "keydown", key: "End", preventDefault() {} });
    await Promise.resolve(); await Promise.resolve();
    tabs = elements(view, '[role="tab"]');
    expect(tabs[8].getAttribute("tabindex")).toBe("0");
    expect(tabs[8].getAttribute("aria-selected")).toBe("true");
  });

  it("groups advanced navigation and exposes a compact pane selector", async () => {
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await view.setProjectPath(snapshot.project.path);
    expect(elements(view, ".cc-research-tab-group")).toHaveLength(4);
    expect(elements(view, ".cc-research-tab-group-label").map(({ textContent }) => textContent)).toEqual(["Build", "Write", "Assure", "Expand"]);
    const compact = elements(view, ".cc-research-tab-select")[0] as HTMLSelectElement;
    expect(compact.getAttribute("aria-label")).toBe("Research workbench section");
    expect(compact.querySelectorAll("option")).toHaveLength(9);
  });

  it("gives every panel a clear purpose and consistent content hierarchy", async () => {
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await view.setProjectPath(snapshot.project.path);
    expect(elements(view, ".cc-research-panel-intro")).toHaveLength(1);
    expect(elements(view, ".cc-research-panel-title")[0]?.textContent).toBe("Project overview");
    expect(elements(view, ".cc-research-panel-description")[0]?.textContent).toContain("research system");

    await view.focus("Sources");
    expect(elements(view, ".cc-research-panel-title")[0]?.textContent).toBe("Source library");
    expect(elements(view, ".cc-research-record-list")).toHaveLength(1);
    expect(elements(view, ".cc-research-record-title")[0]?.textContent).toBe("Source S");
    expect(elements(view, ".cc-research-record-path")[0]?.textContent).toBe("Research/P/Sources/S.md");
  });

  it("uses intentional empty states and prioritizes the action for the active panel", async () => {
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await view.setProjectPath(snapshot.project.path);
    await view.focus("Evidence");
    expect(elements(view, ".cc-research-empty-state")).toHaveLength(1);
    expect(elements(view, ".cc-research-empty-state-title")[0]?.textContent).toBe("No evidence yet");
    expect(elements(view, ".cc-research-empty-state-copy")[0]?.textContent).toContain("reviewed source passages");
    expect(elements(view, ".cc-research-actions-heading")[0]?.textContent).toBe("Workspace actions");
    expect(elements(view, ".is-contextual").map(({ textContent }) => textContent)).toEqual(["Review evidence"]);
  });

  it("reviews proposed evidence natively and returns to the Evidence panel", async () => {
    const proposed = { path: "Research/P/Evidence/E.md", title: "Evidence E", source: "Research/P/Sources/S.md", excerpt: "A directly inspectable passage.", locatorKind: "page", locatorValue: "4", reviewState: "proposed" };
    let current = { ...snapshot, evidence: [proposed] } as never;
    const reviewEvidence = vi.fn(async (_path: string, state: string) => { current = { ...current, evidence: [{ ...proposed, reviewState: state }] } as never; return { ...proposed, reviewState: state }; });
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => current, reviewEvidence } as never);
    await view.setProjectPath(snapshot.project.path);

    click(elements(view, "button").find(({ textContent }) => textContent === "Review evidence"));
    const modal = getLastOpenedModal();
    expect([...modal!.contentEl.querySelectorAll("p")].map(({ textContent }: any) => textContent)).toContain("A directly inspectable passage.");
    click([...modal!.contentEl.querySelectorAll("button")].find(({ textContent }: any) => textContent === "Mark reviewed"));
    await Promise.resolve(); await Promise.resolve();

    expect(reviewEvidence).toHaveBeenCalledWith(proposed.path, "reviewed");
    expect(elements(view, '[role="tab"]').find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toBe("Evidence");
  });

  it("creates a claim from reviewed evidence with explicit relations", async () => {
    const reviewed = { path: "Research/P/Evidence/E.md", title: "Evidence E", source: "Research/P/Sources/S.md", excerpt: "Grounded.", reviewState: "reviewed" };
    const current = { ...snapshot, evidence: [reviewed] } as never;
    const createClaim = vi.fn(async () => ({ path: "Research/P/Claims/Claim.md" }));
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => current, createClaim } as never);
    await view.setProjectPath(snapshot.project.path);

    click(elements(view, "button").find(({ textContent }) => textContent === "Create claim"));
    const modal = getLastOpenedModal()!;
    const inputs = [...modal.contentEl.querySelectorAll("input")] as any[];
    const textarea = modal.contentEl.querySelector("textarea") as any;
    inputs.find((input) => input.getAttribute("aria-label") === "Claim title")!.value = "Claim";
    textarea.value = "The evidence supports this proposition.";
    const support = inputs.find((input) => input.getAttribute("aria-label") === "Evidence E supports");
    support.checked = true;
    click([...modal.contentEl.querySelectorAll("button")].find(({ textContent }: any) => textContent === "Create claim"));
    await Promise.resolve(); await Promise.resolve();

    expect(createClaim).toHaveBeenCalledWith(expect.objectContaining({ project: snapshot.project.path, title: "Claim", proposition: "The evidence supports this proposition.", supports: [reviewed.path] }));
  });

  it("builds an outline from selected reviewed claims and opens the canonical document", async () => {
    const claim = { path: "Research/P/Claims/C.md", title: "Claim C", proposition: "Grounded.", confidence: "moderate", reviewState: "reviewed", supporting: ["Research/P/Evidence/E.md"], challenging: [], contextual: [], limitations: [] };
    const current = { ...snapshot, claims: [claim] } as never;
    const createOutline = vi.fn(async () => ({ path: "Research/P/Documents/Outline.md", content: "# Outline" }));
    const leaf = new WorkspaceLeaf();
    const openFile = vi.fn(async () => undefined);
    leaf.app.vault.seed("Research/P/Documents/Outline.md", "# Outline");
    leaf.app.workspace.getLeaf = () => ({ openFile }) as never;
    const view = new ResearchWorkbenchView(leaf, { loadProject: async () => current, createOutline } as never);
    await view.setProjectPath(snapshot.project.path);

    click(elements(view, "button").find(({ textContent }) => textContent === "Build outline"));
    const modal = getLastOpenedModal()!;
    const selected = [...modal.contentEl.querySelectorAll("input")].find((input: any) => input.getAttribute("aria-label") === "Include Claim C") as any;
    expect(selected.checked).toBe(true);
    click([...modal.contentEl.querySelectorAll("button")].find(({ textContent }: any) => textContent === "Build outline"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(createOutline).toHaveBeenCalledWith(snapshot.project.path, [claim.path]);
    expect(openFile).toHaveBeenCalled();
  });

  it("accepts a contextual handoff from the Research Desk", async () => {
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never);
    await view.setProjectPath(snapshot.project.path);
    await view.focus("Claims");
    const selected = elements(view, '[role="tab"]').find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toBe("Claims");
  });

  it("selects Discover without implicit network or model work", async () => {
    const coordinator = discoveryCoordinator();
    const h = intelligenceDependencies();
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never, { ...h.dependencies, discoveryCoordinator: coordinator });
    await view.setProjectPath(snapshot.project.path);
    click(elements(view, '[role="tab"]')[8]); await Promise.resolve(); await Promise.resolve();
    expect(elements(view, "button").map(({ textContent }) => textContent)).toContain("Search");
    expect(coordinator.search).not.toHaveBeenCalled(); expect(coordinator.rerank).not.toHaveBeenCalled();
  });

  it("renders deterministic intelligence only when selected and refreshes it without implicit model analysis", async () => {
    let current = snapshot;
    const h = intelligenceDependencies();
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => current } as never, h.dependencies);
    await view.setProjectPath(snapshot.project.path);
    click(elements(view, '[role="tab"]')[7]);
    await Promise.resolve(); await Promise.resolve();
    expect(elements(view, ".cc-intelligence-category")).toHaveLength(4);
    expect(h.analyzeCalls).toBe(0);
    current = { ...snapshot, questions: [{ path: "Q.md", title: "Open", question: "What changed?", status: "open", about: "C.md" }] } as never;
    await view.render();
    expect(elements(view, ".cc-intelligence-finding")).toHaveLength(2);
    expect(h.analyzeCalls).toBe(0);
  });

  it("cancels active intelligence on project replacement and close", async () => {
    const h = intelligenceDependencies();
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: async () => snapshot } as never, h.dependencies);
    await view.setProjectPath("Research/One/Project.md");
    await view.setProjectPath("Research/Two/Project.md");
    await view.onClose();
    expect(h.cancelCalls).toBe(2);
  });

  it("cancels discovery on project replacement and close, suppresses late rerank render, and resubscribes on reopen", async () => {
    let subscriptions = 0; let unsubscriptions = 0; let cancels = 0; let resolve!: () => void;
    const coordinator = discoveryCoordinator({
      subscribe: () => { subscriptions += 1; return () => { unsubscriptions += 1; }; },
      cancel: () => { cancels += 1; },
      stateFor: (current: typeof snapshot) => ({ status: "ready", query: { text: "q", projectPath: current.project.path }, ranked: [{ candidate: { id: "W1", title: "Candidate", authors: [], openAlexId: "W1", provenance: {}, disagreements: [], verification: "verified" }, deterministicRank: 1, totalScore: 1, factors: { queryRelevance: 1, projectOverlap: 0, citationRelationship: 0, recency: 0, openAccess: 0, metadataCompleteness: 1 } }], deterministicOrder: ["W1"], partialAdapters: [], fingerprint: "f" }),
      rerank: () => new Promise((done) => { resolve = () => done({}); }),
    });
    const h = intelligenceDependencies();
    const repository = { loadProject: async (path: string) => ({ ...snapshot, project: { ...snapshot.project, path } }) } as never;
    const retainDiscoveryCoordinator = vi.fn(); const releaseDiscoveryCoordinator = vi.fn();
    const retainIntelligenceCoordinator = vi.fn(); const releaseIntelligenceCoordinator = vi.fn();
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), repository, { ...h.dependencies, discoveryCoordinator: coordinator, retainDiscoveryCoordinator, releaseDiscoveryCoordinator, retainIntelligenceCoordinator, releaseIntelligenceCoordinator });
    await view.setProjectPath("Research/One/Project.md"); click(elements(view, '[role="tab"]')[8]); await Promise.resolve(); await Promise.resolve();
    click(elements(view, "button").find(({ textContent }) => textContent === "Rerank with model")); await Promise.resolve();
    await view.setProjectPath("Research/Two/Project.md"); const afterReplacement = view.contentEl.textContent;
    resolve(); await Promise.resolve(); await Promise.resolve();
    expect(view.contentEl.textContent).toBe(afterReplacement); expect(cancels).toBe(1);
    await view.onClose(); expect(unsubscriptions).toBe(1); expect(cancels).toBe(2); expect(releaseDiscoveryCoordinator).toHaveBeenCalledOnce(); expect(releaseIntelligenceCoordinator).toHaveBeenCalledOnce();
    await view.onClose(); expect(releaseDiscoveryCoordinator).toHaveBeenCalledOnce(); expect(releaseIntelligenceCoordinator).toHaveBeenCalledOnce();
    await view.onOpen(); expect(subscriptions).toBe(2); expect(retainDiscoveryCoordinator).toHaveBeenCalledOnce(); expect(retainIntelligenceCoordinator).toHaveBeenCalledOnce();
  });

  it("previews and explicitly accepts one grounded section from the Draft tab", async () => {
    const managed = parseDraftSections(renderDraftSection({ id: "claim-c", claimPaths: ["Research/P/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, "## Claim C\n\nOutline text.")).sections[0];
    if (!managed) throw new Error("missing section fixture");
    const draftSnapshot = { ...snapshot,
      sources: [{ path: "Research/P/Sources/S.md", title: "S", type: "research-source", project: snapshot.project.path, sourceKind: "zotero", zoteroKey: "smith2025", contentFingerprint: "sha256:s" }],
      evidence: [{ path: "Research/P/Evidence/E.md", title: "E", type: "evidence", project: snapshot.project.path, source: "Research/P/Sources/S.md", sourceFingerprint: "sha256:s", locatorKind: "page", locatorValue: "1", excerpt: "Grounded.", reviewState: "reviewed" }],
      claims: [{ path: "Research/P/Claims/C.md", title: "C", type: "claim", project: snapshot.project.path, proposition: "Grounded prose.", confidence: "moderate", reviewState: "reviewed", supporting: ["Research/P/Evidence/E.md"], challenging: [], contextual: [], limitations: [] }],
      documents: [{ path: "Research/P/Documents/Outline.md", title: "Outline", type: "research-document", project: snapshot.project.path, documentKind: "outline", claims: ["Research/P/Claims/C.md"] }] } as never;
    const currentPacket = buildDraftGrounding(draftSnapshot, "Research/P/Claims/C.md");
    const currentEvidence = currentPacket.evidence.map(({ path, fingerprint }) => ({ path, fingerprint }));
    const acceptDraftSection = vi.fn(async () => undefined);
    const repository = { loadProject: async () => draftSnapshot, loadDraftSections: async () => ({ sections: [managed], issues: [] }), acceptDraftSection } as never;
    const preview = vi.fn(async () => ({
      section: managed,
      packet: { claim: { path: "Research/P/Claims/C.md" }, evidence: [{ path: "Research/P/Evidence/E.md", fingerprint: "fixture" }] },
      response: { markdown: "Grounded prose [@smith2025].", support: [], gaps: [] },
      envelope: { ...managed.envelope, evidence: currentEvidence, claimFingerprint: groundingClaimFingerprint(currentPacket), provider: "anthropic", model: "claude-test", generatedAt: "2026-07-14T20:00:00.000Z" },
    }));
    const h = intelligenceDependencies();
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), repository, { ...h.dependencies, draftCoordinator: { preview } as never });
    await view.setProjectPath(snapshot.project.path);
    click(elements(view, '[role="tab"]')[5]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(elements(view, "button").map(({ textContent }) => textContent)).toContain("Preview draft");
    expect(preview).not.toHaveBeenCalled();

    click(elements(view, "button").find(({ textContent }) => textContent === "Preview draft"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(elements(view, ".cc-draft-provider")[0]?.textContent).toBe("anthropic · claude-test");
    expect(elements(view, ".cc-draft-preview")[0]?.textContent).toBe("Grounded prose [@smith2025].");
    expect(elements(view, ".cc-draft-diff")).toHaveLength(1);
    click(elements(view, "button").find(({ textContent }) => textContent === "Accept section"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(acceptDraftSection).toHaveBeenCalledWith(expect.objectContaining({ documentPath: "Research/P/Documents/Outline.md", markdown: "Grounded prose [@smith2025]." }));
  });

  it("surfaces accepted-section evidence drift", async () => {
    const accepted = parseDraftSections(renderDraftSection({ id: "claim-c", claimPaths: ["Research/P/Claims/C.md"], evidence: [{ path: "Research/P/Evidence/E.md", fingerprint: "old" }], citations: [], provider: "anthropic", model: "test", generatedAt: "then" }, "## Claim C\n\nGrounded [@smith2025].")).sections[0];
    if (!accepted) throw new Error("missing section fixture");
    const driftSnapshot = { ...snapshot,
      sources: [{ path: "Research/P/Sources/S.md", title: "S", contentFingerprint: "sha256:s" }],
      evidence: [{ path: "Research/P/Evidence/E.md", source: "Research/P/Sources/S.md", sourceFingerprint: "sha256:s", locatorKind: "page", locatorValue: "1", excerpt: "Changed.", reviewState: "reviewed" }],
      claims: [{ path: "Research/P/Claims/C.md", title: "C", proposition: "Grounded.", confidence: "moderate", reviewState: "reviewed", supporting: ["Research/P/Evidence/E.md"], challenging: [], contextual: [], limitations: [] }],
      documents: [{ path: "Research/P/Documents/Draft.md", title: "Draft", type: "research-document", project: snapshot.project.path, documentKind: "draft", claims: ["Research/P/Claims/C.md"] }] } as never;
    const root = new ResearchWorkbenchView(new WorkspaceLeaf(), {} as never).contentEl;
    new ResearchDraftPanel({ coordinator: {} as never, repository: {} as never, rerender: () => undefined }).render(root, driftSnapshot, driftSnapshot.documents[0], { sections: [accepted], issues: [] });
    expect(root.querySelectorAll(".cc-draft-status")[0]?.textContent).toBe("Evidence changed since review");
  });

  it("revises one accepted section with intent, custom instruction, preservation report, and atomic acceptance", async () => {
    const revisionSnapshot = { ...snapshot,
      sources: [{ path: "Research/P/Sources/S.md", title: "S", contentFingerprint: "sha256:s" }],
      evidence: [{ path: "Research/P/Evidence/E.md", source: "Research/P/Sources/S.md", sourceFingerprint: "sha256:s", locatorKind: "page", locatorValue: "1", excerpt: "Grounded.", reviewState: "reviewed" }],
      claims: [{ path: "Research/P/Claims/C.md", title: "C", proposition: "Grounded.", confidence: "moderate", reviewState: "reviewed", supporting: ["Research/P/Evidence/E.md"], challenging: [], contextual: [], limitations: [] }], documents: [], questions: [], issues: [] } as never;
    const packet = buildDraftGrounding(revisionSnapshot, "Research/P/Claims/C.md");
    const accepted = parseDraftSections(renderDraftSection({ id: "claim-c", claimPaths: [packet.claim.path], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [{ key: "source-s", sourcePath: "Research/P/Sources/S.md" }], provider: "anthropic", model: "draft-model", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) }, "## Claim C\n\nGrounded [@source-s].")).sections[0];
    if (!accepted) throw new Error("missing accepted section");
    const revisionPreview = vi.fn(async (_snapshot, _section, request) => ({ section: accepted, packet, request, response: { markdown: "## Claim C\n\nThe result is grounded [@source-s].", support: [{ passage: "The result is grounded [@source-s].", claimPath: packet.claim.path, evidencePaths: ["Research/P/Evidence/E.md"], citationKeys: ["source-s"] }], claimPreservation: [{ claimPath: packet.claim.path, passage: "The result is grounded [@source-s].", status: "preserved" }], changes: [{ kind: "audience", severity: "warning", description: "Uses general-audience wording." }], gaps: [], warnings: ["Uses general-audience wording."], violations: [], canAccept: true }, envelope: { ...accepted.envelope, revisionIntent: request.intent, revisionInstruction: request.customInstruction, revisedFromFingerprint: "fnv1a-before", generatedAt: "now" } }));
    const acceptRevisionSection = vi.fn(async () => undefined);
    const repository = { loadProject: async () => revisionSnapshot, acceptRevisionSection } as never;
    const panel = new ResearchDraftPanel({ coordinator: {} as never, revisionCoordinator: { preview: revisionPreview } as never, repository, rerender: () => undefined });
    const root = new ResearchWorkbenchView(new WorkspaceLeaf(), {} as never).contentEl;
    panel.render(root, revisionSnapshot, { path: "Research/P/Documents/Draft.md", documentKind: "draft" } as never, { sections: [accepted], issues: [] });
    expect(root.querySelectorAll("button").map(({ textContent }: any) => textContent)).toContain("Revise section");
    expect(root.querySelectorAll("button").map(({ textContent }: any) => textContent)).not.toContain("Preview draft");

    click(root.querySelectorAll("button").find(({ textContent }: any) => textContent === "Revise section")); root.empty();
    panel.render(root, revisionSnapshot, { path: "Research/P/Documents/Draft.md", documentKind: "draft" } as never, { sections: [accepted], issues: [] });
    const select = root.querySelectorAll("select")[0] as any; select.value = "audience"; select.dispatchEvent({ type: "change" });
    const instruction = root.querySelectorAll("textarea")[0] as any; instruction.value = "Explain for policy readers"; instruction.dispatchEvent({ type: "input" });
    click(root.querySelectorAll("button").find(({ textContent }: any) => textContent === "Preview revision")); await Promise.resolve(); await Promise.resolve(); root.empty();
    panel.render(root, revisionSnapshot, { path: "Research/P/Documents/Draft.md", documentKind: "draft" } as never, { sections: [accepted], issues: [] });
    expect(revisionPreview).toHaveBeenCalledWith(revisionSnapshot, accepted, { intent: "audience", customInstruction: "Explain for policy readers" }, expect.any(AbortSignal));
    expect(root.querySelectorAll(".cc-revision-warning")[0]?.textContent).toBe("Uses general-audience wording.");
    click(root.querySelectorAll("button").find(({ textContent }: any) => textContent === "Accept revision")); await Promise.resolve(); await Promise.resolve();
    expect(acceptRevisionSection).toHaveBeenCalledWith(expect.objectContaining({ packet, request: { intent: "audience", customInstruction: "Explain for policy readers" }, response: expect.objectContaining({ canAccept: true }), documentPath: "Research/P/Documents/Draft.md" }));
  });

  it("does not commit a deferred render after close and can render after reopening", async () => {
    const pending = deferred<typeof snapshot>();
    let load = () => pending.promise;
    let subscriptions = 0;
    let unsubscriptions = 0;
    const h = intelligenceDependencies({
      subscribe: () => {
        subscriptions += 1;
        return () => { unsubscriptions += 1; };
      },
    });
    const view = new ResearchWorkbenchView(new WorkspaceLeaf(), { loadProject: () => load() } as never, h.dependencies);
    expect(subscriptions).toBe(1);
    view.contentEl.setText("before close");

    const rendering = view.setProjectPath(snapshot.project.path);
    await Promise.resolve();
    await view.onClose();
    expect(unsubscriptions).toBe(1);
    pending.resolve(snapshot);
    await rendering;

    expect(view.contentEl.textContent).toBe("before close");

    load = async () => snapshot;
    await view.onOpen();
    expect(subscriptions).toBe(2);
    expect(elements(view, "h2").map(({ textContent }) => textContent)).toContain("Project P");
  });

  it("uses one replacement helper to cancel every changed project identity", () => {
    let cancels = 0;
    expect(replaceResearchProjectPath("Research/One/Project.md", "[[Research/Two/Project.md|Two]]", () => { cancels += 1; }))
      .toBe("Research/Two/Project.md");
    expect(replaceResearchProjectPath("Research/Two/Project.md", "Research/Two/Project.md", () => { cancels += 1; }))
      .toBe("Research/Two/Project.md");
    expect(cancels).toBe(1);
  });
});
