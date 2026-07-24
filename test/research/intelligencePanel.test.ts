import { describe, expect, it } from "vitest";
import { ItemView, WorkspaceLeaf } from "obsidian";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { IntelligenceNarrativeState } from "../../src/research/intelligenceCoordinator";
import { ResearchIntelligencePanel } from "../../src/view/ResearchIntelligencePanel";

const snapshot = buildProjectSnapshot("P.md", [
  { path: "P.md", title: "Project", type: "research-project", project: "P.md", question: "Why?", stage: "reason", status: "active" },
  { path: "S1.md", title: "Trial", type: "research-source", project: "P.md", sourceKind: "pdf", contentFingerprint: "sha256:1" },
  { path: "S2.md", title: "Review", type: "research-source", project: "P.md", sourceKind: "doi", contentFingerprint: "sha256:2" },
  { path: "E1.md", title: "Support", type: "evidence", project: "P.md", source: "S1.md", locatorKind: "page", locatorValue: "1", excerpt: "Yes", reviewState: "reviewed", sourceFingerprint: "sha256:1" },
  { path: "E2.md", title: "Challenge", type: "evidence", project: "P.md", source: "S2.md", locatorKind: "page", locatorValue: "2", excerpt: "No", reviewState: "reviewed", sourceFingerprint: "sha256:2" },
  { path: "C.md", title: "Claim", type: "claim", project: "P.md", proposition: "It works", confidence: "moderate", reviewState: "reviewed", supports: ["E1.md"], challenges: ["E2.md"], contextualizes: [], limitations: [] },
], []);

const emptySnapshot = buildProjectSnapshot("Empty.md", [
  { path: "Empty.md", title: "Empty", type: "research-project", project: "Empty.md", question: "Why?", stage: "reason", status: "active" },
], []);

function root(): HTMLElement {
  return new ItemView(new WorkspaceLeaf()).contentEl;
}

function allText(root: HTMLElement): string {
  const visit = (item: any): string => [item.textContent ?? "", ...(item.children ?? []).map(visit)].join(" ");
  return visit(root);
}

function pathButton(root: HTMLElement, path: string): Element | null {
  return [...root.querySelectorAll("button")].find((item) => item.getAttribute("data-path") === path) ?? null;
}

function click(element: Element | null): void {
  if (!element) throw new Error("element not found");
  element.dispatchEvent(new Event("click"));
}

function harness(initial: IntelligenceNarrativeState = { status: "not-analyzed" }) {
  let state = initial;
  let analyzeCalls = 0;
  const opened: string[] = [];
  const panel = new ResearchIntelligencePanel({
    coordinator: {
      stateFor: () => state,
      analyze: async () => { analyzeCalls += 1; return state; },
      cancel: () => undefined,
      subscribe: () => () => undefined,
    } as never,
    openPath: async (path) => { opened.push(path); },
    rerender: async () => undefined,
  });
  return { panel, opened, get analyzeCalls() { return analyzeCalls; }, setState: (next: IntelligenceNarrativeState) => { state = next; } };
}

describe("ResearchIntelligencePanel", () => {
  it("renders category counts and traceable finding cards", async () => {
    const h = harness();
    const container = root();
    h.panel.render(container, snapshot);
    expect([...container.querySelectorAll(".cc-intelligence-category")].map((item) => allText(item as HTMLElement))).toEqual(expect.arrayContaining([expect.stringMatching(/Contradictions\s+1/)]));
    expect([...container.querySelectorAll(".cc-intelligence-epistemic")].map((item) => item.textContent)).toContain("Observation");
    click(pathButton(container, "C.md"));
    await Promise.resolve();
    expect(h.opened).toEqual(["C.md"]);
  });

  it.each([
    ["not-analyzed", "Analyze this project"], ["analyzing", "Analyzing"], ["stale", "Out of date"],
    ["disabled", "Model analysis is disabled"], ["failed", "could not be verified"],
  ] as const)("renders %s", (status, copy) => {
    const result = { briefing: "Brief", groups: [] };
    const state = status === "analyzing" ? { status, cacheKey: "k", providerId: "anthropic", model: "claude-test" }
      : status === "stale" ? { status, cacheKey: "k", providerId: "anthropic", model: "claude-test", usedFallback: false, result }
      : status === "failed" ? { status, message: "The analysis could not be verified." }
      : { status };
    const container = root();
    harness(state as IntelligenceNarrativeState).panel.render(container, snapshot);
    expect(allText(container)).toContain(copy);
  });

  it("calls Analyze only after the button is selected and prevents duplicate clicks", async () => {
    let resolve!: () => void;
    let calls = 0;
    const panel = new ResearchIntelligencePanel({
      coordinator: { stateFor: () => ({ status: "not-analyzed" }), analyze: () => { calls += 1; return new Promise((done) => { resolve = () => done({ status: "not-analyzed" }); }); }, subscribe: () => () => undefined } as never,
      openPath: async () => undefined, rerender: async () => undefined,
    });
    const container = root();
    panel.render(container, snapshot);
    expect(calls).toBe(0);
    const button = [...container.querySelectorAll("button")].find(({ textContent }) => textContent?.includes("Analyze")) ?? null;
    click(button); click(button);
    expect(calls).toBe(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve();
    await Promise.resolve(); await Promise.resolve();
  });

  it("shows provider, model, fallback, narrative links, and failed previous content as stale", async () => {
    const previous = {
      status: "stale", cacheKey: "k", providerId: "ollama", model: "qwen-test", usedFallback: true,
      result: { briefing: "Prior briefing", groups: [{ title: "Priority", insights: [{ text: "Inspect this", epistemicStatus: "inference", paths: ["C.md"] }] }] },
    } as const;
    const container = root();
    const h = harness({ status: "failed", message: "The analysis could not be verified.", previous });
    h.panel.render(container, snapshot);
    expect(allText(container)).toContain("Ollama");
    expect(allText(container)).toContain("qwen-test");
    expect(allText(container)).toContain("Fallback");
    expect(allText(container)).toContain("Prior briefing");
    expect(container.querySelector(".cc-intelligence-stale")).not.toBeNull();
    click([...container.querySelectorAll("button")].filter((item) => item.getAttribute("data-path") === "C.md")[1] ?? null);
    await Promise.resolve();
    expect(h.opened).toEqual(["C.md"]);
  });

  it("renders explicit semantic status copy for a current narrative", () => {
    const container = root();
    harness({
      status: "current", cacheKey: "k", providerId: "anthropic", model: "claude-test", usedFallback: false,
      result: { briefing: "Brief", groups: [] },
    }).panel.render(container, snapshot);
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Analysis current");
  });

  it("uses scoped no-findings copy without implying completeness or correctness", () => {
    const container = root();
    harness().panel.render(container, emptySnapshot);
    const text = allText(container);
    expect(text).toContain("No deterministic issues were found in the current structured records.");
    expect(text).not.toContain("No intelligence findings.");
    expect(text).not.toMatch(/research (?:is )?(?:complete|correct)/i);
  });

  it("renders Disabled after a remembered failure and does not offer Analyze", async () => {
    const h = harness({ status: "failed", message: "Provider failed." });
    const first = root();
    h.panel.render(first, snapshot);
    click([...first.querySelectorAll("button")].find(({ textContent }) => textContent === "Analyze") ?? null);
    await Promise.resolve(); await Promise.resolve();
    h.setState({ status: "disabled" });
    const refreshed = root();
    h.panel.render(refreshed, snapshot);
    expect(allText(refreshed)).toContain("Model analysis is disabled in settings.");
    expect([...refreshed.querySelectorAll("button")].some(({ textContent }) => textContent?.includes("Analyze"))).toBe(false);
  });

  it("rerenders while a deferred fallback is active and unsubscribes on dispose", async () => {
    let listener: (() => void) | undefined;
    let unsubscribed = false;
    let state: IntelligenceNarrativeState = { status: "analyzing", cacheKey: "a", providerId: "anthropic", model: "claude-test", usedFallback: false };
    let rerenders = 0;
    const panel = new ResearchIntelligencePanel({
      coordinator: {
        stateFor: () => state,
        analyze: async () => state,
        cancel: () => { listener?.(); },
        subscribe: (next: () => void) => { listener = next; return () => { unsubscribed = true; listener = undefined; }; },
      } as never,
      openPath: async () => undefined,
      rerender: async () => { rerenders += 1; },
    });
    state = { status: "analyzing", cacheKey: "b", providerId: "ollama", model: "qwen-test", usedFallback: true };
    listener?.();
    await Promise.resolve();
    const container = root();
    panel.render(container, snapshot);
    expect(rerenders).toBe(1);
    expect(allText(container)).toContain("Ollama");
    expect(allText(container)).toContain("qwen-test");
    expect(allText(container)).toContain("Fallback");
    const beforeDispose = rerenders;
    panel.dispose();
    expect(unsubscribed).toBe(true);
    expect(rerenders).toBe(beforeDispose);
  });

  it("discards a pending analysis rerender after cancellation", async () => {
    let finish!: (state: IntelligenceNarrativeState) => void;
    let listener: (() => void) | undefined;
    let rerenders = 0;
    const panel = new ResearchIntelligencePanel({
      coordinator: {
        stateFor: () => ({ status: "not-analyzed" }),
        analyze: () => { listener?.(); return new Promise((resolve) => { finish = resolve; }); },
        cancel: () => undefined,
        subscribe: (next: () => void) => { listener = next; return () => undefined; },
      } as never,
      openPath: async () => undefined,
      rerender: async () => { rerenders += 1; },
    });
    const container = root();
    panel.render(container, snapshot);
    click([...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Analyze") ?? null);
    await Promise.resolve();
    expect(rerenders).toBe(1);
    panel.cancel();
    finish({ status: "failed", message: "Analysis canceled." });
    await Promise.resolve(); await Promise.resolve();
    expect(rerenders).toBe(1);
  });
});
