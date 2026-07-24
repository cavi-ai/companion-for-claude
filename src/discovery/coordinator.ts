import { isOfflineOrUsageError, shouldFallbackToLocal, type ChatBackend } from "../providers/fallback";
import type { Provider, ProviderId } from "../providers/types";
import type { ProjectSnapshot } from "../research/graph";
import type { ImportSourceInput, ImportSourceResult, ResearchRepository } from "../research/repository";
import type { ArxivAdapter } from "./adapters/arxiv";
import type { CrossrefAdapter } from "./adapters/crossref";
import type { DiscoveryPage, OpenAlexAdapter } from "./adapters/openAlex";
import { candidateId } from "./identity";
import { mergeAdapterWorks } from "./normalize";
import { deriveDiscoveryQuery } from "./query";
import { rankCandidates, type RankedCandidate } from "./rank";
import { rerankCandidates, type ModelRankedCandidate } from "./rerank";
import type { AdapterWork, CitationDirection, DiscoveryAdapterId, DiscoveryCandidate, DiscoveryQuery } from "./types";

export interface DiscoveryCoordinatorDeps {
  openAlex: Pick<OpenAlexAdapter, "search" | "expand">;
  crossref: Pick<CrossrefAdapter, "lookupDoi">;
  arxiv: Pick<ArxivAdapter, "lookup">;
  repository: Pick<ResearchRepository, "importSource">;
  enabled: () => boolean;
  cacheHours: () => number;
  rerankerMode: () => "current" | "claude" | "local" | "disabled";
  chatBackend: () => ChatBackend;
  anthropic: () => { provider: Provider; model: string };
  local: () => { provider: Provider; model: string };
  localAvailable: () => Promise<boolean>;
  now?: () => Date;
}

export interface DiscoveryValidState {
  status: "ready" | "stale";
  query: DiscoveryQuery;
  ranked: RankedCandidate[];
  deterministicOrder: string[];
  modelOrder?: string[];
  modelRanked?: ModelRankedCandidate[];
  providerId?: ProviderId;
  model?: string;
  usedFallback?: boolean;
  rerankIdentity?: string;
  partialAdapters: DiscoveryAdapterId[];
  cursor?: string;
  fingerprint: string;
}

export type DiscoveryState =
  | { status: "disabled"; query: DiscoveryQuery }
  | { status: "idle"; query: DiscoveryQuery }
  | { status: "searching"; query: DiscoveryQuery; requestId: number; previous?: DiscoveryValidState }
  | DiscoveryValidState
  | { status: "failed"; query: DiscoveryQuery; message: string; previous?: DiscoveryValidState };

export type ImportCandidateOutcome =
  | { candidateId: string; status: ImportSourceResult["kind"]; path: string }
  | { candidateId: string; status: "failed"; message: string };

interface CacheEntry {
  key: string;
  projectPath: string;
  sequence: number;
  state: DiscoveryValidState;
  cachedAt: number;
}

interface ActiveRequest {
  key: string;
  sequence: number;
  controller: AbortController;
  query: DiscoveryQuery;
  fingerprint: string;
  previous?: DiscoveryValidState;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function snapshotFingerprint(snapshot: ProjectSnapshot): string {
  const projection = {
    project: { path: snapshot.project.path, question: snapshot.project.question },
    claims: snapshot.claims.map(({ path, proposition, reviewState }) => ({ path, proposition, reviewState })).sort((a, b) => compare(a.path, b.path)),
    sources: snapshot.sources.map(({ path, canonicalId, doi, arxivId, url }) => ({ path, canonicalId, doi, arxivId, url })).sort((a, b) => compare(a.path, b.path)),
  };
  return JSON.stringify(projection);
}

function operationKey(kind: string, query: DiscoveryQuery, fingerprint: string, cursor?: string, extra = ""): string {
  return JSON.stringify([kind, query.projectPath, query.text, fingerprint, cursor ?? "", extra]);
}

function validCopy(state: DiscoveryValidState, status: "ready" | "stale" = state.status): DiscoveryValidState {
  return { ...state, status, ranked: [...state.ranked], deterministicOrder: [...state.deterministicOrder],
    ...(state.modelOrder ? { modelOrder: [...state.modelOrder] } : {}),
    ...(state.modelRanked ? { modelRanked: [...state.modelRanked] } : {}), partialAdapters: [...state.partialAdapters] };
}

function safeFailure(kind: "search" | "rerank" | "import" | "seed"): string {
  if (kind === "rerank") return "The discovery rerank could not be completed.";
  if (kind === "import") return "The source could not be imported.";
  if (kind === "seed") return "The selected discovery candidate cannot be expanded.";
  return "Scholarly discovery could not be completed.";
}

export class DiscoveryCoordinator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly dismissed = new Set<string>();
  private readonly controllers = new Map<number, AbortController>();
  private active: ActiveRequest | undefined;
  private current: { key: string; projectPath: string; fingerprint: string; state: DiscoveryState } | undefined;
  private desiredKey: string | undefined;
  private desiredProjectPath: string | undefined;
  private desiredFingerprint: string | undefined;
  private sequence = 0;

  constructor(private readonly deps: DiscoveryCoordinatorDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  stateFor(snapshot: ProjectSnapshot): DiscoveryState {
    const query = deriveDiscoveryQuery(snapshot);
    if (!this.deps.enabled()) return { status: "disabled", query };
    const fingerprint = snapshotFingerprint(snapshot);
    if (this.active && this.active.fingerprint === fingerprint && this.active.query.projectPath === query.projectPath && this.active.key === this.desiredKey) {
      return { status: "searching", query: this.active.query, requestId: this.active.sequence, ...(this.active.previous ? { previous: validCopy(this.active.previous) } : {}) };
    }
    if (this.current?.projectPath === query.projectPath) {
      if (this.current.fingerprint === fingerprint) {
        const currentState = this.current.state;
        const state = currentState.status === "ready" || currentState.status === "stale" ? this.withCurrentRerank(currentState) : currentState;
        if ((state.status === "ready" || state.status === "stale") && this.expired(this.current.key)) return validCopy(state, "stale");
        if (state.status === "failed" && state.previous && this.expired(this.current.key)) return { ...state, previous: validCopy(state.previous, "stale") };
        return state;
      }
      const valid = this.current.state.status === "ready" || this.current.state.status === "stale"
        ? this.current.state
        : this.current.state.status === "failed" ? this.current.state.previous : undefined;
      return valid
        ? validCopy(valid, "stale")
        : { status: "stale", query, ranked: [], deterministicOrder: [], partialAdapters: [], fingerprint: this.current.fingerprint };
    }
    const desired = this.desiredKey ? this.cache.get(this.desiredKey) : undefined;
    if (desired?.projectPath === query.projectPath) {
      return validCopy(this.withCurrentRerank(desired.state), desired.state.fingerprint === fingerprint && !this.expired(desired.key) ? "ready" : "stale");
    }
    if (this.desiredProjectPath === query.projectPath && this.desiredFingerprint !== undefined && this.desiredFingerprint !== fingerprint) {
      return { status: "stale", query, ranked: [], deterministicOrder: [], partialAdapters: [], fingerprint: this.desiredFingerprint };
    }
    return { status: "idle", query };
  }

  async search(snapshot: ProjectSnapshot, text: string, cursor?: string): Promise<DiscoveryState> {
    const query = { text: text.trim(), projectPath: snapshot.project.path };
    if (!this.deps.enabled()) return { status: "disabled", query };
    return this.request(snapshot, query, "search", cursor, (signal) => this.deps.openAlex.search(query, cursor, signal));
  }

  async expand(snapshot: ProjectSnapshot, candidateId: string, direction: CitationDirection, cursor?: string): Promise<DiscoveryState> {
    if (!this.deps.enabled()) return { status: "disabled", query: deriveDiscoveryQuery(snapshot) };
    const current = this.currentValid(snapshot.project.path);
    const seed = current?.state.ranked.find(({ candidate }) => candidate.id === candidateId)?.candidate;
    const query = current?.state.query ?? deriveDiscoveryQuery(snapshot);
    if (!seed?.openAlexId) {
      const state: DiscoveryState = { status: "failed", query, message: safeFailure("seed"), ...(current ? { previous: validCopy(current.state) } : {}) };
      this.setCurrent(operationKey("expand", query, snapshotFingerprint(snapshot), cursor, `${candidateId}:${direction}`), snapshotFingerprint(snapshot), state);
      return state;
    }
    return this.request(snapshot, query, "expand", cursor, (signal) => this.deps.openAlex.expand({ seedOpenAlexId: seed.openAlexId!, direction, ...(cursor ? { cursor } : {}) }, signal), `${candidateId}:${direction}`, { seedId: candidateId, direction });
  }

  async rerank(snapshot: ProjectSnapshot): Promise<DiscoveryState> {
    if (!this.deps.enabled()) return { status: "disabled", query: deriveDiscoveryQuery(snapshot) };
    const current = this.currentValid(snapshot.project.path);
    const query = current?.state.query ?? deriveDiscoveryQuery(snapshot);
    if (!current || current.state.fingerprint !== snapshotFingerprint(snapshot) || this.expired(current.key)) return current ? validCopy(current.state, "stale") : { status: "idle", query };
    const mode = this.deps.rerankerMode();
    const chatBackend = this.deps.chatBackend();
    if (mode === "disabled") {
      const state: DiscoveryState = { status: "failed", query, message: safeFailure("rerank"), previous: validCopy(current.state) };
      this.setCurrent(current.key, current.state.fingerprint, state);
      return state;
    }
    const resolved = mode === "claude" ? this.deps.anthropic()
      : mode === "local" ? this.deps.local()
      : chatBackend === "local" ? this.deps.local()
      : this.deps.anthropic();
    const controller = new AbortController();
    const sequence = ++this.sequence;
    this.active = { key: current.key, sequence, controller, query, fingerprint: current.state.fingerprint, previous: current.state };
    this.controllers.set(sequence, controller);
    this.notify();
    try {
      let chosen = resolved;
      let usedFallback = false;
      let modelRanked: ModelRankedCandidate[];
      try {
        if (!chosen.provider.hasCredentials()) throw Object.assign(new Error("Provider credential unavailable"), { status: 401 });
        modelRanked = await rerankCandidates(chosen.provider, query, current.state.ranked, chosen.model, controller.signal);
      } catch (error) {
        const classified = this.fallbackError(error);
        const eligible = mode === "current" && chatBackend === "auto" && isOfflineOrUsageError(classified) && shouldFallbackToLocal({
          backend: "auto",
          localAvailable: await this.deps.localAvailable(),
          error: classified,
        });
        if (!eligible || controller.signal.aborted) throw error;
        chosen = this.deps.local();
        if (!chosen.provider.hasCredentials()) throw error;
        usedFallback = true;
        modelRanked = await rerankCandidates(chosen.provider, query, current.state.ranked, chosen.model, controller.signal);
      }
      if (controller.signal.aborted || sequence !== this.sequence) return validCopy(current.state, "stale");
      const state: DiscoveryValidState = { ...validCopy(current.state, "ready"), modelRanked, modelOrder: modelRanked.map(({ candidate }) => candidate.id), providerId: chosen.provider.id, model: chosen.model, usedFallback, rerankIdentity: this.rerankIdentity(current.state, chosen.provider.id, chosen.model) };
      this.cache.set(current.key, { ...current, sequence, state, cachedAt: this.nowMs() });
      this.setCurrent(current.key, current.state.fingerprint, state, false);
      return state;
    } catch {
      if (controller.signal.aborted || sequence !== this.sequence) {
        const state = validCopy(current.state, "stale");
        this.setCurrent(current.key, current.state.fingerprint, state, false);
        return state;
      }
      const state: DiscoveryState = { status: "failed", query, message: safeFailure("rerank"), previous: validCopy(current.state) };
      this.setCurrent(current.key, current.state.fingerprint, state, false);
      return state;
    } finally {
      this.controllers.delete(sequence);
      if (this.active?.sequence === sequence) this.active = undefined;
      this.notify();
    }
  }

  async importCandidates(snapshot: ProjectSnapshot, candidateIds: readonly string[]): Promise<ImportCandidateOutcome[]> {
    const current = this.currentValid(snapshot.project.path);
    const candidates = new Map(current?.state.ranked.map(({ candidate }) => [candidate.id, candidate]) ?? []);
    const outcomes: ImportCandidateOutcome[] = [];
    for (const candidateId of candidateIds) {
      const candidate = candidates.get(candidateId);
      if (!candidate) {
        outcomes.push({ candidateId, status: "failed", message: safeFailure("import") });
        continue;
      }
      try {
        const result = await this.deps.repository.importSource(snapshot.project.path, this.importInput(candidate));
        outcomes.push({ candidateId, status: result.kind, path: result.path });
      } catch {
        outcomes.push({ candidateId, status: "failed", message: safeFailure("import") });
      }
    }
    return outcomes;
  }

  dismiss(candidateId: string): void {
    if (this.dismissed.has(candidateId)) return;
    let changed = false;
    this.dismissed.add(candidateId);
    for (const [key, entry] of this.cache) {
      const ranked = entry.state.ranked.filter(({ candidate }) => candidate.id !== candidateId);
      if (ranked.length === entry.state.ranked.length) continue;
      changed = true;
      const state = { ...entry.state, ranked, deterministicOrder: ranked.map(({ candidate }) => candidate.id),
        ...(entry.state.modelOrder ? { modelOrder: entry.state.modelOrder.filter((id) => id !== candidateId) } : {}),
        ...(entry.state.modelRanked ? { modelRanked: entry.state.modelRanked.filter(({ candidate }) => candidate.id !== candidateId) } : {}) };
      if (state.modelOrder) state.rerankIdentity = this.rerankIdentity(state, state.providerId, state.model);
      this.cache.set(key, { ...entry, state });
      if (this.current?.key === key && (this.current.state.status === "ready" || this.current.state.status === "stale")) {
        this.current = { ...this.current, state };
      }
    }
    if (changed) this.notify();
  }

  cancel(): void {
    if (this.controllers.size === 0) return;
    this.sequence += 1;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    if (this.active) {
      const state = this.active.previous
        ? validCopy(this.active.previous, "stale")
        : { status: "stale" as const, query: this.active.query, ranked: [], deterministicOrder: [], partialAdapters: [], fingerprint: this.active.fingerprint };
      this.current = { key: this.active.key, projectPath: this.active.query.projectPath, fingerprint: this.active.fingerprint, state };
    }
    this.active = undefined;
    this.notify();
  }

  clearCache(): void {
    const changed = this.cache.size > 0 || this.dismissed.size > 0 || this.desiredKey !== undefined || this.current !== undefined;
    this.cache.clear();
    this.dismissed.clear();
    this.desiredKey = undefined;
    this.desiredProjectPath = undefined;
    this.desiredFingerprint = undefined;
    this.current = undefined;
    if (changed) this.notify();
  }

  private async request(snapshot: ProjectSnapshot, query: DiscoveryQuery, kind: "search" | "expand", cursor: string | undefined,
    load: (signal: AbortSignal) => Promise<DiscoveryPage>, extra = "", relationship?: { seedId: string; direction: CitationDirection }): Promise<DiscoveryState> {
    const fingerprint = snapshotFingerprint(snapshot);
    const key = operationKey(kind, query, fingerprint, cursor, extra);
    const controller = new AbortController();
    const sequence = ++this.sequence;
    const previous = this.currentValid(query.projectPath)?.state;
    this.desiredKey = key;
    this.desiredProjectPath = query.projectPath;
    this.desiredFingerprint = fingerprint;
    this.active = { key, sequence, controller, query, fingerprint, ...(previous ? { previous } : {}) };
    this.controllers.set(sequence, controller);
    this.notify();
    try {
      const page = await load(controller.signal);
      const grouped = new Map<string, AdapterWork[]>();
      for (const item of page.items) {
        try {
          const id = candidateId(item);
          grouped.set(id, [...(grouped.get(id) ?? []), item]);
        } catch { /* Ignore results without a stable scholarly identity. */ }
      }
      const groups = [...grouped.values()];
      const partial = new Set<DiscoveryAdapterId>();
      await Promise.all([
        this.enrich(groups, "crossref", (item) => item.doi, (id) => this.deps.crossref.lookupDoi(id, controller.signal), partial),
        this.enrich(groups, "arxiv", (item) => item.arxivId, (id) => this.deps.arxiv.lookup(id, controller.signal), partial),
      ]);
      const candidates = groups.flatMap((works) => {
        try {
          const candidate = mergeAdapterWorks(works, snapshot.sources);
          if (relationship) candidate.relationship = { ...relationship, adapter: "openalex" };
          return this.dismissed.has(candidate.id) ? [] : [candidate];
        } catch { return []; }
      });
      const ranked = rankCandidates(query, candidates, (this.deps.now ?? (() => new Date()))());
      const status = sequence === this.sequence && key === this.desiredKey && !controller.signal.aborted ? "ready" : "stale";
      const state: DiscoveryValidState = { status, query, ranked, deterministicOrder: ranked.map(({ candidate }) => candidate.id), partialAdapters: [...partial].sort(compare), ...(page.nextCursor ? { cursor: page.nextCursor } : {}), fingerprint };
      const existing = this.cache.get(key);
      if (!controller.signal.aborted && (!existing || existing.sequence <= sequence)) {
        this.cache.set(key, { key, projectPath: query.projectPath, sequence, state: { ...state, status: "ready" }, cachedAt: this.nowMs() });
      }
      if (status === "ready") this.setCurrent(key, fingerprint, state, false);
      return state;
    } catch {
      if (controller.signal.aborted || sequence !== this.sequence || key !== this.desiredKey) {
        const cached = this.cache.get(key)?.state ?? previous;
        return cached ? validCopy(cached, "stale") : { status: "stale", query, ranked: [], deterministicOrder: [], partialAdapters: [], fingerprint };
      }
      const state: DiscoveryState = { status: "failed", query, message: safeFailure("search"), ...(previous ? { previous: validCopy(previous) } : {}) };
      this.setCurrent(key, fingerprint, state, false);
      return state;
    } finally {
      this.controllers.delete(sequence);
      if (this.active?.sequence === sequence) this.active = undefined;
      this.notify();
    }
  }

  private async enrich(groups: AdapterWork[][], adapter: "crossref" | "arxiv", id: (work: AdapterWork) => string | undefined,
    lookup: (value: string) => Promise<AdapterWork | undefined>, partial: Set<DiscoveryAdapterId>): Promise<void> {
    const lookups = groups.flatMap((group) => {
      const value = id(group[0]!);
      return value ? [{ group, value }] : [];
    });
    await Promise.all(lookups.map(async ({ group, value }) => {
      try { const result = await lookup(value); if (result) group.push(result); } catch { partial.add(adapter); }
    }));
  }

  private importInput(candidate: DiscoveryCandidate): ImportSourceInput {
    const discoveryProvenance = [...new Map(Object.values(candidate.provenance).flat().map(({ adapter, externalId }) => [`${adapter}\u0000${externalId}`, { adapter, externalId }])).values()];
    return { title: candidate.title, sourceKind: candidate.doi ? "doi" : candidate.arxivId ? "arxiv" : "web", canonicalId: candidate.id,
      ...(candidate.url || candidate.openAccessUrl ? { url: candidate.url ?? candidate.openAccessUrl } : {}), ...(candidate.doi ? { doi: candidate.doi } : {}),
      ...(candidate.arxivId ? { arxivId: candidate.arxivId } : {}), ...(candidate.authors.length ? { authors: [...candidate.authors] } : {}),
      ...(candidate.published ? { published: candidate.published } : {}), ...(candidate.publication ? { publication: candidate.publication } : {}),
      ...(candidate.abstract ? { abstract: candidate.abstract } : {}), ...(candidate.openAccessUrl ? { openAccessUrl: candidate.openAccessUrl } : {}),
      ...(discoveryProvenance.length ? { discoveryProvenance } : {}) };
  }

  private currentValid(projectPath: string): CacheEntry | undefined {
    const desired = this.desiredKey ? this.cache.get(this.desiredKey) : undefined;
    return desired?.projectPath === projectPath ? desired : undefined;
  }

  private nowMs(): number { return (this.deps.now ?? (() => new Date()))().getTime(); }

  private rerankIdentity(state: DiscoveryValidState, providerId?: ProviderId, model?: string): string {
    return JSON.stringify([this.deps.rerankerMode(), this.deps.chatBackend(), providerId ?? "", model ?? "", state.deterministicOrder]);
  }

  private withCurrentRerank(state: DiscoveryValidState): DiscoveryValidState {
    if (!state.modelOrder) return state;
    const mode = this.deps.rerankerMode(); const backend = this.deps.chatBackend();
    const resolved = mode === "local" || (mode === "current" && backend === "local") ? this.deps.local() : this.deps.anthropic();
    const expected = this.rerankIdentity(state, state.usedFallback ? this.deps.local().provider.id : resolved.provider.id, state.usedFallback ? this.deps.local().model : resolved.model);
    if (state.rerankIdentity === expected) return state;
    const { modelOrder: _order, modelRanked: _ranked, providerId: _provider, model: _model, usedFallback: _fallback, rerankIdentity: _identity, ...deterministic } = state;
    return deterministic;
  }

  private cacheTtlMs(): number {
    const configured = this.deps.cacheHours();
    const hours = Number.isFinite(configured) ? Math.min(168, Math.max(1, Math.floor(configured))) : 24;
    return hours * 60 * 60 * 1000;
  }

  private expired(key: string): boolean {
    const entry = this.cache.get(key);
    return entry !== undefined && this.nowMs() - entry.cachedAt > this.cacheTtlMs();
  }

  private fallbackError(error: unknown): { message?: string; status?: number } {
    if (!error || typeof error !== "object") return {};
    const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
    const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
    return { ...(message ? { message } : {}), ...(status !== undefined ? { status } : {}) };
  }

  private setCurrent(key: string, fingerprint: string, state: DiscoveryState, notify = true): void {
    this.current = { key, projectPath: state.query.projectPath, fingerprint, state };
    if (notify) this.notify();
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}
