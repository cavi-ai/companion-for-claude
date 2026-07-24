import { describe, expect, it, vi } from "vitest";
import { DiscoveryCoordinator, type DiscoveryCoordinatorDeps } from "../../src/discovery/coordinator";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";
import type { Provider } from "../../src/providers/types";

const work = (id: string, extra: Record<string, unknown> = {}) => ({
  adapter: "openalex" as const, externalId: id, openAlexId: id, title: `Paper ${id}`, authors: ["Ada"], ...extra,
});

function snapshot(question = "How does discovery work?") {
  const records: ResearchRecord[] = [
    { path: "Research/P/Project.md", title: "P", type: "research-project", project: "Research/P/Project.md", question, stage: "frame", status: "active" },
  ];
  return buildProjectSnapshot("Research/P/Project.md", records, []);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(overrides: Partial<DiscoveryCoordinatorDeps> = {}) {
  const imports: unknown[] = [];
  const deps: DiscoveryCoordinatorDeps = {
    openAlex: { search: vi.fn(async () => ({ items: [work("W1", { doi: "10.1/x" })], nextCursor: "next" })), expand: vi.fn(async ({ direction }) => ({ items: [work("W2")], nextCursor: direction })) },
    crossref: { lookupDoi: vi.fn(async () => ({ adapter: "crossref", externalId: "10.1/x", doi: "10.1/x", title: "Enriched", authors: ["Ada"] })) },
    arxiv: { lookup: vi.fn(async () => undefined) },
    repository: { importSource: vi.fn(async (_path, input) => { imports.push(input); return { kind: "created" as const, path: "Sources/X.md" }; }) },
    enabled: () => true,
    cacheHours: () => 24,
    rerankerMode: () => "disabled",
    chatBackend: () => "claude",
    anthropic: () => ({ provider: { id: "anthropic", hasCredentials: () => false } as never, model: "claude" }),
    local: () => ({ provider: { id: "ollama", hasCredentials: () => false } as never, model: "local" }),
    localAvailable: async () => false,
    now: () => new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
  return { deps, coordinator: new DiscoveryCoordinator(deps), imports };
}

const modelProvider = (id: "anthropic" | "ollama", complete: ReturnType<typeof vi.fn>, credentials = true) => ({
  id, label: id, hasCredentials: () => credentials, complete, stream: async () => undefined, test: async () => ({ ok: true, detail: "ok" }),
}) as Provider;

describe("DiscoveryCoordinator", () => {
  it("derives idle state without HTTP or repository work", () => {
    const h = harness();
    expect(h.coordinator.stateFor(snapshot())).toEqual(expect.objectContaining({ status: "idle", query: { text: "How does discovery work?", projectPath: "Research/P/Project.md" } }));
    expect(h.deps.openAlex.search).not.toHaveBeenCalled();
    expect(h.deps.repository.importSource).not.toHaveBeenCalled();
  });

  it("enforces live disabled state at search, expand, and rerank boundaries with zero calls", async () => {
    let enabled = false;
    const complete = vi.fn();
    const h = harness({
      enabled: () => enabled,
      rerankerMode: () => "claude",
      anthropic: () => ({ provider: modelProvider("anthropic", complete), model: "claude" }),
    });
    expect(h.coordinator.stateFor(snapshot()).status).toBe("disabled");
    expect((await h.coordinator.search(snapshot(), "q")).status).toBe("disabled");
    expect((await h.coordinator.expand(snapshot(), "openalex:W1", "references")).status).toBe("disabled");
    expect((await h.coordinator.rerank(snapshot())).status).toBe("disabled");
    expect(h.deps.openAlex.search).not.toHaveBeenCalled();
    expect(h.deps.openAlex.expand).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    enabled = true;
    expect(h.coordinator.stateFor(snapshot()).status).toBe("idle");
    await h.coordinator.search(snapshot(), "q");
    expect(h.deps.openAlex.search).toHaveBeenCalledOnce();
  });

  it("searches explicitly, enriches partially, ranks, and never writes", async () => {
    const h = harness({ crossref: { lookupDoi: vi.fn(async () => { throw new Error("<html>secret</html>"); }) } });
    const state = await h.coordinator.search(snapshot(), "explicit query");
    expect(state).toEqual(expect.objectContaining({ status: "ready", partialAdapters: ["crossref"], cursor: "next" }));
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.ranked).toHaveLength(1);
    expect(state.deterministicOrder).toEqual(["doi:10.1/x"]);
    expect(h.deps.openAlex.search).toHaveBeenCalledTimes(1);
    expect(h.deps.repository.importSource).not.toHaveBeenCalled();
  });

  it("keeps late same-key results stale and caches cross-key results under their own keys", async () => {
    const first = deferred<{ items: ReturnType<typeof work>[] }>();
    const second = deferred<{ items: ReturnType<typeof work>[] }>();
    const search = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockResolvedValueOnce({ items: [work("other")] });
    const h = harness({ openAlex: { search, expand: vi.fn() } });
    const a = h.coordinator.search(snapshot(), "one");
    const b = h.coordinator.search(snapshot(), "one");
    second.resolve({ items: [work("new")] });
    expect((await b).status).toBe("ready");
    first.resolve({ items: [work("old")] });
    expect((await a).status).toBe("stale");
    expect((h.coordinator.stateFor(snapshot()) as { ranked?: Array<{ candidate: { title: string } }> }).ranked?.[0]?.candidate.title).toBe("Paper new");

    const c = h.coordinator.search(snapshot(), "other");
    await c;
    expect(h.coordinator.stateFor(snapshot()).status).toBe("ready");
  });

  it("never promotes a late cross-key result when the desired request fails", async () => {
    const first = deferred<{ items: ReturnType<typeof work>[] }>();
    const second = deferred<{ items: ReturnType<typeof work>[] }>();
    const search = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const h = harness({ openAlex: { search, expand: vi.fn() } });
    const a = h.coordinator.search(snapshot(), "A");
    const b = h.coordinator.search(snapshot(), "B");
    first.resolve({ items: [work("A")] });
    expect((await a).status).toBe("stale");
    second.resolve(Promise.reject(new Error("remote body")) as never);
    expect((await b).status).toBe("failed");
    expect(h.coordinator.stateFor(snapshot())).toEqual(expect.objectContaining({ status: "failed", query: expect.objectContaining({ text: "B" }) }));
  });

  it.each(["references", "cited-by"] as const)("expands exactly one hop with %s provenance", async (direction) => {
    const h = harness();
    const searched = await h.coordinator.search(snapshot(), "q");
    if (searched.status !== "ready") throw new Error("expected ready");
    const expanded = await h.coordinator.expand(snapshot(), searched.ranked[0]!.candidate.id, direction);
    if (expanded.status !== "ready") throw new Error("expected ready");
    expect(h.deps.openAlex.expand).toHaveBeenCalledWith({ seedOpenAlexId: "W1", direction }, expect.any(AbortSignal));
    expect(expanded.ranked[0]!.candidate.relationship).toEqual({ seedId: searched.ranked[0]!.candidate.id, direction, adapter: "openalex" });
  });

  it("uses exact-set reranking and preserves results on provider failure", async () => {
    const provider = modelProvider("anthropic", vi.fn(async () => '{"order":[{"id":"openalex:W1","reason":"Only"}]}'));
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() }, rerankerMode: () => "claude", anthropic: () => ({ provider, model: "explicit" }) });
    await h.coordinator.search(snapshot(), "q");
    const reranked = await h.coordinator.rerank(snapshot());
    expect(reranked).toEqual(expect.objectContaining({ status: "ready", modelOrder: ["openalex:W1"] }));
    provider.complete.mockRejectedValueOnce(new Error("credential secret"));
    const fallback = await h.coordinator.rerank(snapshot());
    expect(fallback).toEqual(expect.objectContaining({ status: "failed", message: "The discovery rerank could not be completed.", previous: expect.objectContaining({ modelOrder: ["openalex:W1"] }) }));
  });

  it("falls back at runtime only for Current plus Auto and discloses the actual local provider/model", async () => {
    const claudeComplete = vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
    const localComplete = vi.fn(async () => '{"order":[{"id":"openalex:W1","reason":"Local"}]}');
    const h = harness({
      openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() },
      rerankerMode: () => "current", chatBackend: () => "auto",
      anthropic: () => ({ provider: modelProvider("anthropic", claudeComplete), model: "claude-model" }),
      local: () => ({ provider: modelProvider("ollama", localComplete), model: "local-model" }),
      localAvailable: async () => true,
    });
    await h.coordinator.search(snapshot(), "q");
    const state = await h.coordinator.rerank(snapshot());
    expect(state).toEqual(expect.objectContaining({ status: "ready", providerId: "ollama", model: "local-model", usedFallback: true }));
    expect(claudeComplete).toHaveBeenCalledOnce();
    expect(localComplete).toHaveBeenCalledWith(expect.objectContaining({ model: "local-model" }));
  });

  it("does not fall back when local is unreachable or the reranker mode is strict", async () => {
    const claudeComplete = vi.fn().mockRejectedValue(Object.assign(new Error("offline"), { status: 503 }));
    const localComplete = vi.fn(async () => '{"order":[{"id":"openalex:W1","reason":"Local"}]}');
    const base = {
      openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() },
      anthropic: () => ({ provider: modelProvider("anthropic", claudeComplete), model: "claude-model" }),
      local: () => ({ provider: modelProvider("ollama", localComplete), model: "local-model" }),
    };
    const unreachable = harness({ ...base, rerankerMode: () => "current", chatBackend: () => "auto", localAvailable: async () => false });
    await unreachable.coordinator.search(snapshot(), "q");
    expect((await unreachable.coordinator.rerank(snapshot())).status).toBe("failed");
    expect(localComplete).not.toHaveBeenCalled();

    claudeComplete.mockClear();
    const strict = harness({ ...base, rerankerMode: () => "claude", chatBackend: () => "auto", localAvailable: async () => true });
    await strict.coordinator.search(snapshot(), "q");
    expect((await strict.coordinator.rerank(snapshot())).status).toBe("failed");
    expect(localComplete).not.toHaveBeenCalled();
  });

  it("does not probe local availability for a non-fallback Claude failure", async () => {
    const localAvailable = vi.fn(async () => true);
    const h = harness({
      openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() },
      rerankerMode: () => "current", chatBackend: () => "auto", localAvailable,
      anthropic: () => ({ provider: modelProvider("anthropic", vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }))), model: "claude" }),
      local: () => ({ provider: modelProvider("ollama", vi.fn()), model: "local" }),
    });
    await h.coordinator.search(snapshot(), "q");
    expect((await h.coordinator.rerank(snapshot())).status).toBe("failed");
    expect(localAvailable).not.toHaveBeenCalled();
  });

  it("honors the exact cache TTL boundary, expiry, and live cache-hour changes without network", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let hours = 2;
    const h = harness({ now: () => now, cacheHours: () => hours });
    await h.coordinator.search(snapshot(), "q");
    const calls = vi.mocked(h.deps.openAlex.search).mock.calls.length;
    now = new Date("2026-01-01T02:00:00Z");
    expect(h.coordinator.stateFor(snapshot()).status).toBe("ready");
    now = new Date("2026-01-01T02:00:00.001Z");
    expect(h.coordinator.stateFor(snapshot()).status).toBe("stale");
    hours = 3;
    expect(h.coordinator.stateFor(snapshot()).status).toBe("ready");
    hours = 1;
    expect(h.coordinator.stateFor(snapshot()).status).toBe("stale");
    expect(h.deps.openAlex.search).toHaveBeenCalledTimes(calls);
  });

  it("preserves valid results when exact-set model output is invalid and exposes failure to subscribers", async () => {
    const provider = modelProvider("anthropic", vi.fn(async () => '{"order":[]}'));
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() }, rerankerMode: () => "claude", anthropic: () => ({ provider, model: "explicit" }) });
    await h.coordinator.search(snapshot(), "q");
    const states: string[] = [];
    h.coordinator.subscribe(() => states.push(h.coordinator.stateFor(snapshot()).status));
    const failed = await h.coordinator.rerank(snapshot());
    expect(failed).toEqual(expect.objectContaining({ status: "failed", previous: expect.objectContaining({ deterministicOrder: ["openalex:W1"] }) }));
    expect(h.coordinator.stateFor(snapshot())).toEqual(failed);
    expect(states).toContain("failed");
  });

  it("returns stale preserved results when cancellation aborts reranking", async () => {
    const complete = vi.fn((request: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new DOMException("private", "AbortError")));
    }));
    const provider = modelProvider("anthropic", complete);
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() }, rerankerMode: () => "claude", anthropic: () => ({ provider, model: "explicit" }) });
    await h.coordinator.search(snapshot(), "q");
    const pending = h.coordinator.rerank(snapshot());
    h.coordinator.cancel();
    expect(await pending).toEqual(expect.objectContaining({ status: "stale", deterministicOrder: ["openalex:W1"] }));
    expect(h.coordinator.stateFor(snapshot()).status).toBe("stale");
  });

  it("stores failed search, missing-provider, and invalid-seed states for stateFor and subscribers", async () => {
    const h = harness({ openAlex: { search: vi.fn(async () => { throw new Error("<html>private</html>"); }), expand: vi.fn() } });
    const observed: string[] = [];
    h.coordinator.subscribe(() => observed.push(h.coordinator.stateFor(snapshot()).status));
    const failed = await h.coordinator.search(snapshot(), "q");
    expect(h.coordinator.stateFor(snapshot())).toEqual(failed);
    expect(observed).toContain("failed");

    const seeded = harness();
    await seeded.coordinator.search(snapshot(), "q");
    const seededObserved: string[] = [];
    seeded.coordinator.subscribe(() => seededObserved.push(seeded.coordinator.stateFor(snapshot()).status));
    const noProvider = await seeded.coordinator.rerank(snapshot());
    expect(seeded.coordinator.stateFor(snapshot())).toEqual(noProvider);
    const invalidSeed = await seeded.coordinator.expand(snapshot(), "missing", "references");
    expect(seeded.coordinator.stateFor(snapshot())).toEqual(invalidSeed);
    expect(seededObserved.filter((status) => status === "failed")).toHaveLength(2);
  });

  it("imports metadata only with duplicate-safe per-item outcomes", async () => {
    const importSource = vi.fn().mockResolvedValueOnce({ kind: "created", path: "A.md" }).mockResolvedValueOnce({ kind: "duplicate", path: "A.md" }).mockRejectedValueOnce(new Error("private"));
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("A"), work("B"), work("C")] })), expand: vi.fn() }, repository: { importSource } });
    const ready = await h.coordinator.search(snapshot(), "q");
    if (ready.status !== "ready") throw new Error("expected ready");
    const outcomes = await h.coordinator.importCandidates(snapshot(), ready.ranked.map(({ candidate }) => candidate.id));
    expect(outcomes.map(({ status }) => status)).toEqual(["created", "duplicate", "failed"]);
    expect(importSource.mock.calls[0]?.[1]).not.toHaveProperty("capturedContent");
  });

  it.each(["javascript:alert(1)", "file:///private/secret", "not a URL"])("omits unsafe URLs before import: %s", async (unsafeUrl) => {
    const importSource = vi.fn(async () => ({ kind: "created" as const, path: "A.md" }));
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("A", { url: unsafeUrl, openAccessUrl: unsafeUrl })] })), expand: vi.fn() }, repository: { importSource } });
    const ready = await h.coordinator.search(snapshot(), "q");
    if (ready.status !== "ready") throw new Error("expected ready");
    await h.coordinator.importCandidates(snapshot(), [ready.ranked[0]!.candidate.id]);
    expect(importSource.mock.calls[0]?.[1]).not.toHaveProperty("url");
    expect(importSource.mock.calls[0]?.[1]).not.toHaveProperty("openAccessUrl");
  });

  it("removes model order immediately when reranker policy or model identity changes", async () => {
    let mode: "claude" | "local" = "claude"; let model = "model-one";
    const provider = modelProvider("anthropic", vi.fn(async () => '{"order":[{"id":"openalex:W1","reason":"Only"}]}'));
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() }, rerankerMode: () => mode, anthropic: () => ({ provider, model }), local: () => ({ provider: modelProvider("ollama"), model: "local-one" }) });
    await h.coordinator.search(snapshot(), "q"); await h.coordinator.rerank(snapshot());
    expect(h.coordinator.stateFor(snapshot())).toHaveProperty("modelOrder");
    model = "model-two";
    expect(h.coordinator.stateFor(snapshot())).not.toHaveProperty("modelOrder");
    await h.coordinator.rerank(snapshot()); mode = "local";
    expect(h.coordinator.stateFor(snapshot())).not.toHaveProperty("modelOrder");
  });

  it("rechecks repeated imports and duplicate IDs within one batch", async () => {
    const importSource = vi.fn().mockResolvedValueOnce({ kind: "created", path: "A.md" }).mockResolvedValue({ kind: "duplicate", path: "A.md" });
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("A")] })), expand: vi.fn() }, repository: { importSource } });
    const ready = await h.coordinator.search(snapshot(), "q");
    if (ready.status !== "ready") throw new Error("expected ready");
    const id = ready.ranked[0]!.candidate.id;
    expect((await h.coordinator.importCandidates(snapshot(), [id, id])).map(({ status }) => status)).toEqual(["created", "duplicate"]);
    expect((await h.coordinator.importCandidates(snapshot(), [id])).map(({ status }) => status)).toEqual(["duplicate"]);
    expect(importSource).toHaveBeenCalledTimes(3);
  });

  it("keeps captured source, evidence, documents, and unrelated data out of rerank", async () => {
    const records: ResearchRecord[] = [
      { path: "Research/P/Project.md", title: "P", type: "research-project", project: "Research/P/Project.md", question: "Safe question", stage: "reason", status: "active" },
      { path: "S.md", title: "Source", type: "research-source", project: "Research/P/Project.md", sourceKind: "web", capturedContent: "CAPTURE_SECRET" },
      { path: "E.md", title: "Evidence", type: "evidence", project: "Research/P/Project.md", source: "S.md", excerpt: "EVIDENCE_SECRET", reviewState: "reviewed" },
      { path: "D.md", title: "Document", type: "research-document", project: "Research/P/Project.md", documentKind: "memo", claims: [], content: "DOCUMENT_SECRET" },
    ];
    const rich = buildProjectSnapshot("Research/P/Project.md", records, []);
    const complete = vi.fn(async () => '{"order":[{"id":"openalex:W1","reason":"Only"}]}');
    const provider = modelProvider("anthropic", complete);
    const h = harness({ openAlex: { search: vi.fn(async () => ({ items: [work("W1")] })), expand: vi.fn() }, rerankerMode: () => "claude", anthropic: () => ({ provider, model: "explicit" }) });
    await h.coordinator.search(rich, "Safe query");
    await h.coordinator.rerank(rich);
    const request = JSON.stringify(complete.mock.calls[0]?.[0]);
    expect(request).not.toMatch(/CAPTURE_SECRET|EVIDENCE_SECRET|DOCUMENT_SECRET/);
  });

  it("marks snapshot changes stale without HTTP and clearCache deletes only derived state", async () => {
    const h = harness();
    await h.coordinator.search(snapshot(), "q");
    const calls = vi.mocked(h.deps.openAlex.search).mock.calls.length;
    expect(h.coordinator.stateFor(snapshot("changed")).status).toBe("stale");
    expect(h.deps.openAlex.search).toHaveBeenCalledTimes(calls);
    h.coordinator.clearCache();
    expect(h.coordinator.stateFor(snapshot()).status).toBe("idle");
    expect(h.deps.repository.importSource).not.toHaveBeenCalled();
  });

  it("dismisses a result only from derived session state", async () => {
    const h = harness();
    const ready = await h.coordinator.search(snapshot(), "q");
    if (ready.status !== "ready") throw new Error("expected ready");
    h.coordinator.dismiss(ready.ranked[0]!.candidate.id);
    expect((h.coordinator.stateFor(snapshot()) as { ranked: unknown[] }).ranked).toEqual([]);
    expect(h.deps.repository.importSource).not.toHaveBeenCalled();
  });

  it("supports dismissal, cancellation, subscriptions, snapshot staleness, and cache clearing", async () => {
    const pending = deferred<{ items: ReturnType<typeof work>[] }>();
    const h = harness({ openAlex: { search: vi.fn(() => pending.promise), expand: vi.fn() } });
    const listener = vi.fn();
    const unsubscribe = h.coordinator.subscribe(listener);
    const request = h.coordinator.search(snapshot(), "q");
    h.coordinator.cancel();
    pending.resolve({ items: [work("W1")] });
    expect((await request).status).toBe("stale");
    expect(h.coordinator.stateFor(snapshot("changed")).status).toBe("stale");
    h.coordinator.clearCache();
    expect(h.coordinator.stateFor(snapshot()).status).toBe("idle");
    unsubscribe();
    const before = listener.mock.calls.length;
    h.coordinator.dismiss("missing");
    expect(listener).toHaveBeenCalledTimes(before);
  });
});
