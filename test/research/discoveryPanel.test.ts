import { describe, expect, it, vi } from "vitest";
import { ItemView, WorkspaceLeaf } from "obsidian";
import { DiscoveryPanel } from "../../src/view/DiscoveryPanel";

const snapshot = {
  project: { path: "Research/P/Project.md", title: "P", question: "climate adaptation", stage: "reason", status: "active" },
  sources: [], evidence: [], claims: [], questions: [], documents: [], issues: [], health: { claimCount: 0, trustedSupportCount: 0, supportedClaimCount: 0 },
} as never;

const candidate = {
  id: "doi:10.1/test", title: "Adaptation evidence", authors: ["Ada Author"], published: "2024", publication: "Research Venue",
  abstract: "A safe plain-text abstract.", doi: "10.1/test", openAlexId: "W1", openAccessUrl: "https://example.test/paper",
  existingSourcePath: "Research/P/Sources/Existing.md", verification: "partial",
  relationship: { seedId: "openalex:seed", direction: "references", adapter: "openalex" },
  provenance: { title: [{ adapter: "openalex", externalId: "W1", value: "Adaptation evidence" }] },
  disagreements: [{ field: "title", values: [{ adapter: "crossref", externalId: "10.1/test", value: "Different title" }] }],
};
const ranked = { candidate, deterministicRank: 1, totalScore: 0.75, factors: { queryRelevance: 1, projectOverlap: .5, citationRelationship: 1, recency: .9, openAccess: 1, metadataCompleteness: .8 } };

function harness(state: any = { status: "idle", query: { text: "climate adaptation", projectPath: snapshot.project.path } }) {
  let listener = () => undefined;
  const calls = { search: 0, expand: [] as string[], rerank: 0, imports: [] as string[][], dismiss: 0, cancel: 0, unsubscribe: 0 };
  const coordinator = {
    stateFor: () => state,
    subscribe: (next: () => void) => { listener = next; return () => { calls.unsubscribe += 1; }; },
    search: vi.fn(async () => { calls.search += 1; return state; }),
    expand: vi.fn(async (_s, _id, direction) => { calls.expand.push(direction); return state; }),
    rerank: vi.fn(async () => { calls.rerank += 1; return state; }),
    importCandidates: vi.fn(async (_s, ids) => { calls.imports.push([...ids]); return ids.map((candidateId: string) => ({ candidateId, status: "created", path: "S.md" })); }),
    dismiss: vi.fn(() => { calls.dismiss += 1; }), cancel: vi.fn(() => { calls.cancel += 1; }),
  };
  const openPath = vi.fn(async () => undefined);
  const rerender = vi.fn(async () => undefined);
  const panel = new DiscoveryPanel({ coordinator: coordinator as never, openPath, rerender });
  const root = new ItemView(new WorkspaceLeaf()).contentEl;
  return { panel, root, calls, coordinator, openPath, rerender, notify: () => listener() };
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
const button = (root: HTMLElement, text: string) => buttons(root).find((item) => item.textContent === text)!;
const click = (item: Element) => item.dispatchEvent({ type: "click" } as never);
const text = (root: HTMLElement) => ["div", "p", "h3", "h4", "dt", "dd", "a", "button"].flatMap((tag) => [...root.querySelectorAll(tag)]).map((item) => item.textContent).join(" ");

describe("DiscoveryPanel", () => {
  it("renders an editable derived query without implicit coordinator actions", () => {
    const h = harness();
    h.root.empty(); h.panel.render(h.root, snapshot);
    expect(h.root.querySelector("input")?.value).toBe("climate adaptation");
    expect(button(h.root, "Search")).toBeTruthy();
    expect(h.calls.search).toBe(0); expect(h.calls.rerank).toBe(0); expect(h.calls.imports).toEqual([]);
  });

  it("runs one explicit search and disables duplicate in-flight clicks", async () => {
    let resolve!: () => void;
    const h = harness();
    h.coordinator.search = vi.fn(() => { h.calls.search += 1; return new Promise<any>((done) => { resolve = () => done({}); }); });
    h.root.empty(); h.panel.render(h.root, snapshot);
    click(button(h.root, "Search")); click(button(h.root, "Search"));
    expect(h.calls.search).toBe(1); expect(button(h.root, "Search").disabled).toBe(true);
    resolve(); await Promise.resolve(); await Promise.resolve();
  });

  it("renders every deterministic factor, metadata, provenance, disagreement, relationship, and explicit action", () => {
    const state = { status: "ready", query: { text: "q", projectPath: snapshot.project.path }, ranked: [ranked], deterministicOrder: [candidate.id], partialAdapters: ["crossref"], fingerprint: "f" };
    const h = harness(state); h.panel.render(h.root, snapshot);
    const rendered = text(h.root);
    for (const value of ["Ada Author", "2024", "Research Venue", "A safe plain-text abstract.", "10.1/test", "Existing source", "Seed openalex:seed", "References", "Deterministic rank 1", "Query Relevance", "Project Overlap", "Citation Relationship", "Recency", "Open Access", "Metadata Completeness", "Provenance", "OpenAlex W1", "Disagreements", "Different title", "Partial metadata: Crossref"]) expect(rendered).toContain(value);
    for (const label of ["References", "Cited by", "Rerank with model", "Import", "Import selected", "Open source", "Dismiss"]) expect(button(h.root, label)).toBeTruthy();
  });

  it("renders disabled, stale, failed-with-previous, searching, and provider disclosure states", () => {
    const valid = { status: "ready", query: { text: "q", projectPath: snapshot.project.path }, ranked: [ranked], deterministicOrder: [candidate.id], partialAdapters: [], fingerprint: "f", providerId: "anthropic", model: "model-x", usedFallback: true };
    for (const [state, expected] of [
      [{ status: "disabled", query: valid.query }, "Enable it in Companion settings"],
      [{ ...valid, status: "stale" }, "Out of date"],
      [{ status: "searching", query: valid.query, requestId: 1, previous: valid }, "Searching"],
      [{ status: "failed", query: valid.query, message: "safe failure", previous: valid }, "safe failure"],
      [valid, "Anthropic · model-x · Fallback"],
    ] as const) { const h = harness(state); h.panel.render(h.root, snapshot); expect(text(h.root)).toContain(expected); }
  });

  it("replaces unusable discovery controls with one clear disabled state", () => {
    const h = harness({ status: "disabled", query: { text: "q", projectPath: snapshot.project.path } });
    h.panel.render(h.root, snapshot);
    expect(h.root.querySelector("input")).toBeNull();
    expect(buttons(h.root)).toHaveLength(0);
    expect(text(h.root)).toContain("Enable it in Companion settings");
  });

  it("invokes separate expansion, rerank, import, batch, dismiss, and open actions", async () => {
    const state = { status: "ready", query: { text: "q", projectPath: snapshot.project.path }, ranked: [ranked], deterministicOrder: [candidate.id], partialAdapters: [], fingerprint: "f" };
    const h = harness(state); h.panel.render(h.root, snapshot);
    const checkbox = [...h.root.querySelectorAll("input")][1] as HTMLInputElement; checkbox.checked = true; checkbox.dispatchEvent({ type: "change" } as never); await Promise.resolve();
    h.root.empty(); h.panel.render(h.root, snapshot);
    for (const label of ["References", "Cited by", "Rerank with model", "Import", "Import selected", "Open source", "Dismiss"]) { click(button(h.root, label)); await Promise.resolve(); }
    expect(h.calls.expand).toEqual(["references", "cited-by"]); expect(h.calls.rerank).toBe(1);
    expect(h.calls.imports).toEqual([[candidate.id]]); expect(h.calls.dismiss).toBe(1);
    expect(h.openPath).toHaveBeenCalledWith(candidate.existingSourcePath);
    expect(h.root.querySelector("a")?.getAttribute("href")).toBe(candidate.openAccessUrl);
  });

  it.each(["javascript:alert(1)", "file:///private/secret", "not a URL"])("does not render unsafe external links: %s", (unsafeUrl) => {
    const state = { status: "ready", query: { text: "q", projectPath: snapshot.project.path }, ranked: [{ ...ranked, candidate: { ...candidate, openAccessUrl: unsafeUrl } }], deterministicOrder: [candidate.id], partialAdapters: [], fingerprint: "f" };
    const h = harness(state as never); h.panel.render(h.root, snapshot);
    expect(h.root.querySelector("a")).toBeNull();
  });

  it("uses a unique query input id per panel and connects each label", () => {
    const first = harness(); const second = harness();
    first.panel.render(first.root, snapshot); second.panel.render(second.root, snapshot);
    const firstInput = first.root.querySelector("input")!; const secondInput = second.root.querySelector("input")!;
    expect(firstInput.getAttribute("id")).not.toBe(secondInput.getAttribute("id"));
    expect(first.root.querySelector("label")?.getAttribute("for")).toBe(firstInput.getAttribute("id"));
    expect(second.root.querySelector("label")?.getAttribute("for")).toBe(secondInput.getAttribute("id"));
  });

  it("renders Importing immediately, prevents overlapping shared-candidate imports, then renders the outcome", async () => {
    const state = { status: "ready", query: { text: "q", projectPath: snapshot.project.path }, ranked: [ranked], deterministicOrder: [candidate.id], partialAdapters: [], fingerprint: "f" };
    const h = harness(state);
    let resolve!: (value: any) => void;
    h.coordinator.importCandidates = vi.fn(() => new Promise((done) => { resolve = done; }));
    h.rerender.mockImplementation(async () => { h.root.empty(); h.panel.render(h.root, snapshot); });
    h.panel.render(h.root, snapshot);
    const checkbox = [...h.root.querySelectorAll("input")][1] as HTMLInputElement; checkbox.checked = true; checkbox.dispatchEvent({ type: "change" } as never);
    await Promise.resolve();
    click(button(h.root, "Import")); await Promise.resolve(); await Promise.resolve();
    expect(text(h.root)).toContain("Importing…");
    expect(button(h.root, "Import").disabled).toBe(true); expect(button(h.root, "Import selected").disabled).toBe(true);
    click(button(h.root, "Import selected"));
    expect(h.coordinator.importCandidates).toHaveBeenCalledTimes(1);
    resolve([{ candidateId: candidate.id, status: "created", path: "S.md" }]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(text(h.root)).toContain("Created");
  });

  it("discards a late rerank completion after disposal", async () => {
    const state = { status: "ready", query: { text: "q", projectPath: snapshot.project.path }, ranked: [ranked], deterministicOrder: [candidate.id], partialAdapters: [], fingerprint: "f" };
    const h = harness(state); let resolve!: () => void;
    h.coordinator.rerank = vi.fn(() => new Promise<any>((done) => { resolve = () => done(state); }));
    h.panel.render(h.root, snapshot); click(button(h.root, "Rerank with model")); await Promise.resolve();
    h.panel.dispose(); resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.rerender).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes before cancel and discards late action completion after disposal", async () => {
    const order: string[] = [];
    let resolve!: () => void;
    const h = harness();
    h.coordinator.subscribe = vi.fn(() => () => { order.push("unsubscribe"); });
    h.coordinator.cancel = vi.fn(() => { order.push("cancel"); });
    h.coordinator.search = vi.fn(() => new Promise<any>((done) => { resolve = () => done({}); }));
    const panel = new DiscoveryPanel({ coordinator: h.coordinator as never, openPath: vi.fn(), rerender: vi.fn(async () => { order.push("rerender"); }) });
    panel.render(h.root, snapshot); click(button(h.root, "Search")); panel.dispose(); resolve(); await Promise.resolve(); await Promise.resolve();
    expect(order.filter((item) => item !== "rerender")).toEqual(["unsubscribe", "cancel"]); expect(order.filter((item) => item === "rerender")).toHaveLength(1);
  });
});
