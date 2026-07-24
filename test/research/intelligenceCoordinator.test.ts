import { describe, expect, it } from "vitest";
import type { Provider } from "../../src/providers/types";
import { IntelligenceCoordinator, type IntelligenceCoordinatorDeps, type IntelligenceNarratorMode } from "../../src/research/intelligenceCoordinator";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { IntelligenceFinding } from "../../src/research/intelligence";
import type { ResearchRecord } from "../../src/research/types";

const valid = JSON.stringify({ briefing: "Brief", groups: [{ title: "Priority", insights: [{ text: "Check both records", epistemicStatus: "observation", paths: ["C.md"] }] }] });

function validWithBriefing(briefing: string): string {
  return JSON.stringify({ briefing, groups: [{ title: "Priority", insights: [{ text: "Check both records", epistemicStatus: "observation", paths: ["C.md"] }] }] });
}

function makeSnapshot(title = "Project") {
  const records: ResearchRecord[] = [
    { path: "P.md", title, type: "research-project", project: "P.md", question: "Does it work?", audience: "Researchers", stage: "reason", status: "active" },
    { path: "C.md", title: "Claim", type: "claim", project: "P.md", proposition: "It works", confidence: "moderate", reviewState: "reviewed", supports: [], challenges: [], contextualizes: [], limitations: [] },
  ];
  return buildProjectSnapshot("P.md", records, []);
}

const findings: IntelligenceFinding[] = [{
  id: "research-gap:unsupported:C.md", category: "research-gap", severity: "warning", confidence: "high",
  epistemicStatus: "observation", title: "Unsupported", rationale: "No support", paths: ["C.md"], verification: "Check it",
}];

type HarnessOptions = {
  mode: IntelligenceNarratorMode;
  chatBackend: "claude" | "local" | "auto";
  anthropicResults?: Array<string | Error | { status: number; message: string }>;
  ollamaResults?: Array<string | Error | { status: number; message: string }>;
  localAvailable?: boolean;
  anthropicCredentials?: boolean;
  ollamaCredentials?: boolean;
};

function harness(options: HarnessOptions) {
  const calls: string[] = [];
  const requests: Array<{ provider: string; request: Parameters<Provider["complete"]>[0] }> = [];
  let mode = options.mode;
  let anthropicModel = "claude-test";
  let localModel = "local-test";
  const provider = (id: "anthropic" | "ollama", results: Array<string | Error | { status: number; message: string }> = [valid]): Provider => ({
    id, label: id, hasCredentials: () => id === "anthropic" ? options.anthropicCredentials ?? true : options.ollamaCredentials ?? true, stream: async () => undefined, test: async () => ({ ok: true, detail: "ok" }),
    complete: async (request) => {
      calls.push(id);
      requests.push({ provider: id, request });
      const next = results.shift() ?? valid;
      if (typeof next === "string") return next;
      throw next;
    },
  });
  const anthropic = provider("anthropic", options.anthropicResults);
  const ollama = provider("ollama", options.ollamaResults);
  const deps: IntelligenceCoordinatorDeps = {
    mode: () => mode, chatBackend: () => options.chatBackend,
    anthropic: () => ({ provider: anthropic, model: anthropicModel }),
    local: () => ({ provider: ollama, model: localModel }),
    localAvailable: async () => options.localAvailable ?? true,
    maxTokens: () => 777,
  };
  return {
    coordinator: new IntelligenceCoordinator(deps), deps, calls, requests, snapshot: makeSnapshot(), changedSnapshot: makeSnapshot("Changed"), findings,
    setMode: (value: IntelligenceNarratorMode) => { mode = value; },
    setAnthropicModel: (value: string) => { anthropicModel = value; },
    setLocalModel: (value: string) => { localModel = value; },
  };
}

describe("IntelligenceCoordinator", () => {
  it.each([
    ["current", "local", "ollama"], ["current", "claude", "anthropic"], ["claude", "local", "anthropic"], ["local", "claude", "ollama"],
  ] as const)("routes %s with chat %s to %s", async (mode, chatBackend, expected) => {
    const h = harness({ mode, chatBackend });
    const state = await h.coordinator.analyze(h.snapshot, h.findings);
    expect(state).toEqual(expect.objectContaining({ status: "current", providerId: expected, usedFallback: false }));
    expect(h.calls).toEqual([expected]);
    expect(h.requests[0]?.request).toEqual(expect.objectContaining({ maxTokens: 777, temperature: 0 }));
  });

  it("uses eligible local fallback only for current plus Auto and discloses Ollama", async () => {
    const h = harness({ mode: "current", chatBackend: "auto", anthropicResults: [{ status: 429, message: "rate limit" }], ollamaResults: [valid] });
    expect(await h.coordinator.analyze(h.snapshot, h.findings)).toEqual(expect.objectContaining({ status: "current", providerId: "ollama", usedFallback: true }));
    expect(h.calls).toEqual(["anthropic", "ollama"]);
  });

  it("notifies subscribers when an active Auto analysis switches to local fallback", async () => {
    let resolveLocal!: (value: string) => void;
    const h = harness({ mode: "current", chatBackend: "auto", anthropicResults: [{ status: 429, message: "rate limit" }] });
    h.deps.local().provider.complete = () => new Promise<string>((resolve) => { resolveLocal = resolve; });
    const states: string[] = [];
    const unsubscribe = h.coordinator.subscribe(() => {
      const state = h.coordinator.stateFor(h.snapshot, h.findings);
      if (state.status === "analyzing") states.push(`${state.providerId}:${state.model}:${state.usedFallback}`);
    });

    const pending = h.coordinator.analyze(h.snapshot, h.findings);
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toContain("ollama:local-test:true");
    resolveLocal(valid);
    await pending;
    unsubscribe();
  });

  it("keeps an unchanged Auto fallback current and makes it stale when the local model changes", async () => {
    const h = harness({ mode: "current", chatBackend: "auto", anthropicResults: [{ status: 429, message: "rate limit" }] });
    await h.coordinator.analyze(h.snapshot, h.findings);
    expect(h.coordinator.stateFor(h.snapshot, h.findings)).toEqual(expect.objectContaining({ status: "current", providerId: "ollama", model: "local-test" }));
    h.setLocalModel("local-new");
    expect(h.coordinator.stateFor(h.snapshot, h.findings)).toEqual(expect.objectContaining({ status: "stale", providerId: "ollama", model: "local-test" }));
  });

  it.each([
    {
      name: "Ollama fallback followed by Anthropic",
      anthropicResults: [{ status: 429, message: "rate limit" }, validWithBriefing("Second")],
      ollamaResults: [validWithBriefing("First")],
      expectedProvider: "anthropic",
    },
    {
      name: "Anthropic followed by Ollama fallback",
      anthropicResults: [validWithBriefing("First"), { status: 429, message: "rate limit" }],
      ollamaResults: [validWithBriefing("Second")],
      expectedProvider: "ollama",
    },
  ] as const)("returns the most recent unchanged Auto analysis: $name", async ({ anthropicResults, ollamaResults, expectedProvider }) => {
    const h = harness({ mode: "current", chatBackend: "auto", anthropicResults: [...anthropicResults], ollamaResults: [...ollamaResults] });
    await h.coordinator.analyze(h.snapshot, h.findings);
    await h.coordinator.analyze(h.snapshot, h.findings);

    expect(h.coordinator.stateFor(h.snapshot, h.findings)).toEqual(expect.objectContaining({
      status: "current",
      providerId: expectedProvider,
      result: expect.objectContaining({ briefing: "Second" }),
    }));
  });

  it.each([
    ["claude", "claude", "Add your Anthropic credential"],
    ["local", "claude", "ollama serve"],
    ["current", "claude", "Add your Anthropic credential"],
    ["current", "local", "ollama serve"],
  ] as const)("does not call an unavailable provider in %s mode with %s chat and gives setup guidance", async (mode, chatBackend, message) => {
    const h = harness({ mode, chatBackend, anthropicCredentials: false, ollamaCredentials: false });
    const state = await h.coordinator.analyze(h.snapshot, h.findings);
    expect(state).toEqual(expect.objectContaining({ status: "failed", message: expect.stringContaining(message) }));
    expect(h.calls).toEqual([]);
  });

  it("uses eligible local fallback when current plus Auto has no primary credential", async () => {
    const h = harness({ mode: "current", chatBackend: "auto", anthropicCredentials: false, ollamaCredentials: true, localAvailable: true });
    expect(await h.coordinator.analyze(h.snapshot, h.findings)).toEqual(expect.objectContaining({ status: "current", providerId: "ollama", usedFallback: true }));
    expect(h.calls).toEqual(["ollama"]);
  });

  it.each(["claude", "local"] as const)("does not cross-provider fallback in explicit %s mode", async (mode) => {
    const h = harness({ mode, chatBackend: mode === "claude" ? "local" : "claude", anthropicResults: [{ status: 429, message: "secret request body" }], ollamaResults: [new Error("offline")] });
    const state = await h.coordinator.analyze(h.snapshot, h.findings);
    expect(state.status).toBe("failed");
    expect(h.calls).toEqual([mode === "claude" ? "anthropic" : "ollama"]);
    if (state.status === "failed") expect(state.message).not.toContain("secret request body");
  });

  it("does not call a provider when disabled", async () => {
    const h = harness({ mode: "disabled", chatBackend: "claude" });
    expect(await h.coordinator.analyze(h.snapshot, h.findings)).toEqual({ status: "disabled" });
    expect(h.calls).toEqual([]);
  });

  it("marks a prior valid result stale after a snapshot, model, or mode change without rerunning", async () => {
    const h = harness({ mode: "current", chatBackend: "claude" });
    await h.coordinator.analyze(h.snapshot, h.findings);
    expect(h.coordinator.stateFor(h.changedSnapshot, h.findings).status).toBe("stale");
    h.setAnthropicModel("claude-new");
    expect(h.coordinator.stateFor(h.snapshot, h.findings).status).toBe("stale");
    h.setMode("disabled");
    expect(h.coordinator.stateFor(h.snapshot, h.findings)).toEqual({ status: "disabled" });
    expect(h.calls).toEqual(["anthropic"]);
  });

  it("does not replace the last valid result after provider or validation failure", async () => {
    const h = harness({ mode: "current", chatBackend: "claude", anthropicResults: [valid, "invalid"] });
    await h.coordinator.analyze(h.snapshot, h.findings);
    const failed = await h.coordinator.analyze(h.changedSnapshot, h.findings);
    expect(failed.status).toBe("failed");
    expect(failed.status === "failed" && failed.previous?.result.briefing).toBe("Brief");
  });

  it("ignores a late result for the active state and exposes no vault dependency", async () => {
    let resolve!: (value: string) => void;
    const h = harness({ mode: "current", chatBackend: "claude" });
    h.deps.anthropic().provider.complete = () => new Promise<string>((done) => { resolve = done; });
    const pending = h.coordinator.analyze(h.snapshot, h.findings);
    expect(h.coordinator.stateFor(h.changedSnapshot, h.findings).status).toBe("not-analyzed");
    resolve(valid);
    await pending;
    expect(h.coordinator.stateFor(h.changedSnapshot, h.findings).status).toBe("stale");
    expect("vault" in h.deps).toBe(false);
  });

  it("keeps the newer same-key analysis current when an abort-ignoring older call resolves late", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const h = harness({ mode: "current", chatBackend: "claude" });
    h.deps.anthropic().provider.complete = () => new Promise<string>((resolve) => { resolvers.push(resolve); });

    const older = h.coordinator.analyze(h.snapshot, h.findings);
    const newer = h.coordinator.analyze(h.snapshot, h.findings);
    resolvers[1]?.(validWithBriefing("Newer"));
    const newerState = await newer;
    resolvers[0]?.(validWithBriefing("Older"));
    const olderState = await older;

    expect(newerState).toEqual(expect.objectContaining({ status: "current", result: expect.objectContaining({ briefing: "Newer" }) }));
    expect(olderState).toEqual(expect.objectContaining({ status: "stale", result: expect.objectContaining({ briefing: "Older" }) }));
    expect(h.coordinator.stateFor(h.snapshot, h.findings)).toEqual(expect.objectContaining({
      status: "current",
      result: expect.objectContaining({ briefing: "Newer" }),
    }));
  });

  it("keeps an older cross-key result stale when stateFor inspects its key after a newer request starts", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const h = harness({ mode: "current", chatBackend: "claude" });
    h.deps.anthropic().provider.complete = () => new Promise<string>((resolve) => { resolvers.push(resolve); });

    const older = h.coordinator.analyze(h.snapshot, h.findings);
    const newer = h.coordinator.analyze(h.changedSnapshot, h.findings);
    expect(h.coordinator.stateFor(h.snapshot, h.findings).status).toBe("not-analyzed");
    resolvers[0]?.(validWithBriefing("Older A"));
    const olderState = await older;
    resolvers[1]?.(validWithBriefing("Newer B"));
    const newerState = await newer;

    expect(olderState).toEqual(expect.objectContaining({ status: "stale", result: expect.objectContaining({ briefing: "Older A" }) }));
    expect(newerState).toEqual(expect.objectContaining({ status: "current", result: expect.objectContaining({ briefing: "Newer B" }) }));
  });

  it("aborts the live request on cancel", async () => {
    const h = harness({ mode: "current", chatBackend: "claude" });
    let signal: AbortSignal | undefined;
    h.deps.anthropic().provider.complete = (request) => new Promise<string>((_done, reject) => {
      signal = request.signal;
      request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    const pending = h.coordinator.analyze(h.snapshot, h.findings);
    expect(h.coordinator.stateFor(h.snapshot, h.findings)).toEqual(expect.objectContaining({ status: "analyzing", providerId: "anthropic", model: "claude-test" }));
    h.coordinator.cancel();
    expect((await pending).status).toBe("failed");
    expect(signal?.aborted).toBe(true);
  });
});
