import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { DiscoveryCoordinator, type DiscoveryCoordinatorDeps, type DiscoveryValidState } from "../../src/discovery/coordinator";
import { deriveDiscoveryQuery } from "../../src/discovery/query";
import type { AdapterWork } from "../../src/discovery/types";
import type { Provider } from "../../src/providers/types";
import { buildProjectSnapshot } from "../../src/research/graph";
import { ResearchRepository, type ResearchRepositoryIO } from "../../src/research/repository";
import { renderResearchRecord } from "../../src/research/render";
import type { ResearchRecord } from "../../src/research/types";

const projectPath = "Research/Discovery/Project.md";

const records: ResearchRecord[] = [
  { path: projectPath, title: "Discovery", type: "research-project", project: projectPath, question: "How does open research discovery preserve scholarly provenance?", stage: "gather", status: "active" },
  { path: "Research/Discovery/Sources/Seed.md", title: "Seed", type: "research-source", project: projectPath, sourceKind: "doi", canonicalId: "doi:10.1000/seed", doi: "10.1000/seed", contentFingerprint: "sha256:seed" },
  { path: "Research/Discovery/Evidence/Seed evidence.md", title: "Seed evidence", type: "evidence", project: projectPath, source: "Research/Discovery/Sources/Seed.md", sourceFingerprint: "sha256:seed", locatorKind: "page", locatorValue: "4", excerpt: "Reviewed evidence", reviewState: "reviewed" },
  { path: "Research/Discovery/Claims/Reviewed claim.md", title: "Reviewed claim", type: "claim", project: projectPath, proposition: "Open discovery should retain inspectable provenance.", confidence: "high", reviewState: "reviewed", supports: ["Research/Discovery/Evidence/Seed evidence.md"], challenges: [], contextualizes: [], limitations: [] },
  { path: "Research/Discovery/Questions/Follow-up.md", title: "Follow-up", type: "research-question", project: projectPath, question: "Which graph direction is most useful?", status: "open" },
];

function inMemoryVault() {
  const notes = new Map(records.map((record) => [record.path, renderResearchRecord(record)]));
  const writes: Array<{ path: string; content: string }> = [];
  const io: ResearchRepositoryIO = {
    listMarkdown: async () => [...notes].map(([path, content]) => noteInput(path, content)),
    listProjectMarkdown: async () => [...notes].map(([path, content]) => noteInput(path, content)),
    createWithParents: vi.fn(async (path: string, content: string) => {
      writes.push({ path, content });
      notes.set(path, content);
    }),
    updateFrontmatter: vi.fn(async () => undefined),
  };
  return { repository: new ResearchRepository(io), writes };
}

function noteInput(path: string, content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return { path, frontmatter: match ? parse(match[1] ?? "") : undefined, body: match?.[2] ?? content };
}

function work(id: string, extra: Partial<AdapterWork> = {}): AdapterWork {
  return { adapter: "openalex", externalId: id, openAlexId: id, title: `Open paper ${id}`, authors: ["Ada Lovelace"], ...extra };
}

function provider(complete: ReturnType<typeof vi.fn>): Provider {
  return { id: "anthropic", label: "Claude", hasCredentials: () => true, complete, stream: async () => undefined, test: async () => ({ ok: true, detail: "ok" }) };
}

function valid(state: Awaited<ReturnType<DiscoveryCoordinator["search"]>>): DiscoveryValidState {
  if (state.status !== "ready" && state.status !== "stale") throw new Error(`Expected valid discovery state, received ${state.status}`);
  return state;
}

describe("scholarly discovery end-to-end contract", () => {
  it("keeps discovery read-only until an explicit duplicate-safe Source Record import", async () => {
    const vault = inMemoryVault();
    const snapshot = await vault.repository.loadProject(projectPath);
    const baseline = {
      evidence: snapshot.evidence,
      claims: snapshot.claims,
      questions: snapshot.questions,
    };
    const openAlex = {
      search: vi.fn(async () => ({ items: [
        work("W1", { doi: "10.5555/discovery", abstract: "OpenAlex abstract", openAccessUrl: "https://oa.example/paper", url: "https://openalex.org/W1" }),
        work("W2", { arxivId: "2401.01234", abstract: "Second abstract" }),
      ] })),
      expand: vi.fn(async () => ({ items: [work("W3", { doi: "10.5555/expanded", abstract: "Expansion abstract", openAccessUrl: "https://oa.example/expanded" })] })),
    };
    const crossref = { lookupDoi: vi.fn(async (doi: string) => ({ adapter: "crossref" as const, externalId: doi, doi, title: doi.endsWith("expanded") ? "Expanded provenance paper" : "Provenance preserving discovery", authors: ["Ada Lovelace"], publication: "Journal of Open Research", published: "2025", abstract: "Crossref abstract" })) };
    const arxiv = { lookup: vi.fn(async (id: string) => ({ adapter: "arxiv" as const, externalId: id, arxivId: id, title: "ArXiv discovery paper", authors: ["Grace Hopper"], published: "2024", abstract: "ArXiv abstract", url: `https://arxiv.org/abs/${id}` })) };
    const complete = vi.fn(async (request: { messages: Array<{ content: string }> }) => {
      const ids = (JSON.parse(request.messages[0]!.content) as { candidates: Array<{ id: string }> }).candidates.map(({ id }) => id).reverse();
      return JSON.stringify({ order: ids.map((id) => ({ id, reason: `Model reason for ${id}` })) });
    });
    const calls = { enabled: true };
    const deps: DiscoveryCoordinatorDeps = {
      openAlex, crossref, arxiv, repository: vault.repository,
      enabled: () => calls.enabled, cacheHours: () => 24, rerankerMode: () => "claude", chatBackend: () => "claude",
      anthropic: () => ({ provider: provider(complete), model: "claude-contract" }),
      local: () => ({ provider: provider(vi.fn()), model: "unused" }), localAvailable: async () => false,
      now: () => new Date("2026-07-14T00:00:00Z"),
    };
    const coordinator = new DiscoveryCoordinator(deps);

    expect(coordinator.stateFor(snapshot).status).toBe("idle");
    const derivedQuery = deriveDiscoveryQuery(snapshot);
    const searched = valid(await coordinator.search(snapshot, derivedQuery.text));
    expect(searched.ranked).toHaveLength(2);
    expect(searched.partialAdapters).toEqual([]);
    expect(openAlex.search).toHaveBeenCalledWith(derivedQuery, undefined, expect.any(AbortSignal));
    expect(crossref.lookupDoi).toHaveBeenCalledWith("10.5555/discovery", expect.any(AbortSignal));
    expect(arxiv.lookup).toHaveBeenCalledWith("2401.01234", expect.any(AbortSignal));
    expect(vault.writes).toHaveLength(0);

    const rerankedSearch = valid(await coordinator.rerank(snapshot));
    expect(rerankedSearch.modelOrder).toEqual([...searched.deterministicOrder].reverse());
    expect(rerankedSearch.modelOrder).not.toEqual(searched.deterministicOrder);
    expect(new Set(rerankedSearch.modelOrder)).toEqual(new Set(searched.deterministicOrder));
    expect(rerankedSearch.ranked.map(({ candidate, deterministicRank, factors }) => ({ id: candidate.id, deterministicRank, factors })))
      .toEqual(searched.ranked.map(({ candidate, deterministicRank, factors }) => ({ id: candidate.id, deterministicRank, factors })));
    expect(rerankedSearch).toEqual(expect.objectContaining({ providerId: "anthropic", model: "claude-contract", usedFallback: false }));

    const seedId = searched.ranked.find(({ candidate }) => candidate.openAlexId === "W1")!.candidate.id;
    const dismissedId = searched.ranked.find(({ candidate }) => candidate.openAlexId === "W2")!.candidate.id;
    coordinator.dismiss(dismissedId);
    const afterDismiss = valid(coordinator.stateFor(snapshot));
    expect(afterDismiss.ranked.map(({ candidate }) => candidate.id)).not.toContain(dismissedId);
    expect(afterDismiss.modelOrder).not.toContain(dismissedId);
    expect(afterDismiss.ranked.map(({ candidate }) => candidate.id)).toEqual([seedId]);
    expect(vault.writes).toHaveLength(0);

    const expanded = valid(await coordinator.expand(snapshot, seedId, "references"));
    expect(expanded.ranked).toHaveLength(1);
    expect(expanded.ranked[0]!.candidate.relationship).toEqual({ seedId, direction: "references", adapter: "openalex" });
    expect(openAlex.expand).toHaveBeenCalledWith({ seedOpenAlexId: "W1", direction: "references" }, expect.any(AbortSignal));

    const reranked = valid(await coordinator.rerank(snapshot));
    expect(new Set(reranked.modelOrder)).toEqual(new Set(reranked.deterministicOrder));
    expect(reranked.ranked.map(({ candidate, deterministicRank, factors }) => ({ id: candidate.id, deterministicRank, factors })))
      .toEqual(expanded.ranked.map(({ candidate, deterministicRank, factors }) => ({ id: candidate.id, deterministicRank, factors })));
    expect(reranked).toEqual(expect.objectContaining({ providerId: "anthropic", model: "claude-contract", usedFallback: false }));
    coordinator.stateFor(snapshot);
    expect(vault.writes).toHaveLength(0);

    const importId = reranked.ranked[0]!.candidate.id;
    expect(await coordinator.importCandidates(snapshot, [importId])).toEqual([{ candidateId: importId, status: "created", path: "Research/Discovery/Sources/Expanded provenance paper.md" }]);
    expect(vault.writes).toHaveLength(1);
    expect(vault.writes[0]!.content).toMatch(/title: "Expanded provenance paper"/);
    expect(vault.writes[0]!.content).toMatch(/abstract: "Crossref abstract"/);
    expect(vault.writes[0]!.content).toMatch(/open_access_url: "https:\/\/oa\.example\/expanded"/);
    expect(vault.writes[0]!.content).toMatch(/canonical_id: "doi:10\.5555\/expanded"/);
    expect(vault.writes[0]!.content).toMatch(/doi: "10\.5555\/expanded"/);
    expect(vault.writes[0]!.content).toContain('discovery_provenance: [{"adapter":"openalex","external_id":"W3"},{"adapter":"crossref","external_id":"10.5555/expanded"}]');

    expect(await coordinator.importCandidates(snapshot, [importId])).toEqual([{ candidateId: importId, status: "duplicate", path: "Research/Discovery/Sources/Expanded provenance paper.md" }]);
    expect(vault.writes).toHaveLength(1);
    const afterImport = await vault.repository.loadProject(projectPath);
    const imported = afterImport.sources.find(({ path }) => path === "Research/Discovery/Sources/Expanded provenance paper.md");
    expect(imported).toEqual(expect.objectContaining({
      title: "Expanded provenance paper",
      canonicalId: "doi:10.5555/expanded",
      doi: "10.5555/expanded",
      authors: ["Ada Lovelace"],
      published: "2025",
      publication: "Journal of Open Research",
      abstract: "Crossref abstract",
      url: "https://oa.example/expanded",
      openAccessUrl: "https://oa.example/expanded",
      discoveryProvenance: [
        { adapter: "openalex", externalId: "W3" },
        { adapter: "crossref", externalId: "10.5555/expanded" },
      ],
    }));
    expect({ evidence: afterImport.evidence, claims: afterImport.claims, questions: afterImport.questions }).toEqual(baseline);

    const networkCalls = openAlex.search.mock.calls.length + openAlex.expand.mock.calls.length + crossref.lookupDoi.mock.calls.length + arxiv.lookup.mock.calls.length;
    const staleSnapshot = buildProjectSnapshot(projectPath, records.map((record) => record.type === "research-project" ? { ...record, question: `${record.question} Updated` } : record), []);
    expect(coordinator.stateFor(staleSnapshot).status).toBe("stale");
    expect(openAlex.search.mock.calls.length + openAlex.expand.mock.calls.length + crossref.lookupDoi.mock.calls.length + arxiv.lookup.mock.calls.length).toBe(networkCalls);
    coordinator.clearCache();
    expect(vault.writes).toHaveLength(1);

    crossref.lookupDoi.mockRejectedValueOnce(new Error("Crossref unavailable"));
    const partial = valid(await coordinator.search(snapshot, "partial enrichment"));
    expect(partial.ranked.some(({ candidate }) => candidate.openAlexId === "W1")).toBe(true);
    expect(partial.partialAdapters).toEqual(["crossref"]);
    const deterministic = partial.ranked.map(({ candidate, deterministicRank, factors }) => ({ id: candidate.id, deterministicRank, factors }));
    complete.mockResolvedValueOnce('{"order":[]}');
    const invalid = await coordinator.rerank(snapshot);
    expect(invalid).toEqual(expect.objectContaining({ status: "failed", previous: expect.any(Object) }));
    if (invalid.status !== "failed" || !invalid.previous) throw new Error("Expected preserved prior results");
    expect(invalid.previous.ranked.map(({ candidate, deterministicRank, factors }) => ({ id: candidate.id, deterministicRank, factors }))).toEqual(deterministic);
    expect(vault.writes).toHaveLength(1);

    calls.enabled = false;
    const beforeDisabled = { search: openAlex.search.mock.calls.length, expand: openAlex.expand.mock.calls.length, crossref: crossref.lookupDoi.mock.calls.length, arxiv: arxiv.lookup.mock.calls.length, model: complete.mock.calls.length };
    expect((await coordinator.search(snapshot, "disabled")).status).toBe("disabled");
    expect((await coordinator.expand(snapshot, importId, "cited-by")).status).toBe("disabled");
    expect((await coordinator.rerank(snapshot)).status).toBe("disabled");
    expect({ search: openAlex.search.mock.calls.length, expand: openAlex.expand.mock.calls.length, crossref: crossref.lookupDoi.mock.calls.length, arxiv: arxiv.lookup.mock.calls.length, model: complete.mock.calls.length }).toEqual(beforeDisabled);
    expect(vault.writes).toHaveLength(1);
  });
});
