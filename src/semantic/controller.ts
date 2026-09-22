import { SemanticIndexer, type IndexFile } from "./indexer";
import { extractPdfPages } from "./pdf";
import type { IndexData } from "./store";
import { OllamaEmbedder, embedderId, type Embedder } from "./embedder";
import { builtinModelById } from "./transformers/model";
import { clearCachedModel, hasCachedModel } from "./transformers/cache";
import { TransformersEmbedder, type WorkerLike } from "./transformers/embedder";
import { createEmbedWorker } from "./transformers/workerSource";
import { classifyEmbeddingFailure, type EmbeddingRecovery } from "./recovery";
import type { PluginSettings } from "../types";
import type { ProviderRouter } from "../providers/router";
import type { ActivityStore } from "../activity/store";
import type { EnrichDiagnostics } from "../sources/enrichDiagnostics";

export interface SemanticControllerDeps {
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  manifestDir: string;
  manifestId: string;
  activity: () => ActivityStore;
  enrichDiagnostics: () => EnrichDiagnostics;
  router: () => ProviderRouter;
  isMobile: boolean;
  vault: {
    adapterExists: (path: string) => Promise<boolean>;
    adapterRead: (path: string) => Promise<string>;
    adapterWrite: (path: string, data: string) => Promise<void>;
    getMarkdownFiles: () => IndexFile[];
    getPdfFiles: () => IndexFile[];
    getAbstractFileByPath: (path: string) => { path: string; stat: { mtime: number; size: number } } | null;
    cachedRead: (path: string) => Promise<string>;
    readBinary: (path: string) => Promise<ArrayBuffer>;
  };
  notice: (message: string, timeout?: number) => { hide: () => void };
  openChoiceModal: <T extends string>(opts: {
    title: string;
    message: string;
    buttons: Array<{ label: string; value: T; cta?: boolean }>;
    fallback: T;
    onChoice: (c: T) => void;
  }) => void;
  mobileSourceNoteMaxBytes: number;
  mobilePdfMaxBytes: number;
}

export class SemanticController {
  private _indexer: SemanticIndexer | null = null;
  private indexerModel: string | null = null;
  private _builtinEmbedder: TransformersEmbedder | null = null;
  private _builtinModelCached = false;
  private reindexPausedNotified = false;
  private reindexTimer: number | null = null;
  private reindexQueue = new Set<string>();
  private reindexSuspended = 0;

  constructor(private deps: SemanticControllerDeps) {}

  destroy(): void {
    this._builtinEmbedder?.terminate();
    this._builtinEmbedder = null;
    if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
  }

  private indexPath(): string {
    return `${this.deps.manifestDir ?? `.obsidian/plugins/${this.deps.manifestId}`}/semantic-index.json`;
  }

  indexer(): SemanticIndexer | null {
    const s = this.deps.settings();
    if (!s.semanticEnabled) return null;
    const model = embedderId(s.embeddingEngine, s.embeddingModel, s.builtinEmbeddingModel, s.openaiCompatEmbeddingModel);
    if (this._indexer && this.indexerModel === model) return this._indexer;

    const path = this.indexPath();
    const embedder: Embedder =
      s.embeddingEngine === "builtin"
        ? this.builtinEmbedder()
        : s.embeddingEngine === "custom"
          ? new OllamaEmbedder(model, (_m, input) => this.deps.router().openaiCompat.embed(s.openaiCompatEmbeddingModel, input))
          : new OllamaEmbedder(s.embeddingModel, (m, input) => this.deps.router().ollama.embed(m, input));
    this._indexer = new SemanticIndexer({
      embeddingModel: model,
      listMarkdown: () => this.deps.vault.getMarkdownFiles(),
      read: async (p: string) => {
        const f = this.deps.vault.getAbstractFileByPath(p);
        return f ? this.deps.vault.cachedRead(p) : "";
      },
      ...(s.semanticIndexPdfs
        ? {
            listPdf: () => this.deps.vault.getPdfFiles(),
            readPdfPages: async (p: string) => {
              const f = this.deps.vault.getAbstractFileByPath(p);
              if (!f) return null;
              try {
                const { loadPdf } = await import("./pdfjs");
                return await extractPdfPages(loadPdf, await this.deps.vault.readBinary(p));
              } catch (e) {
                console.debug("Claude Companion: skipping unreadable PDF", p, e);
                return null;
              }
            },
          }
        : {}),
      embed: async (input: string[]) => {
        if (!(await this.canEmbedWithoutDownload())) {
          throw new Error("Built-in embedding model not downloaded — download it in Companion settings.");
        }
        return embedder.embed(input);
      },
      ...(this.deps.isMobile && s.embeddingEngine === "builtin" ? { embedBatchSize: 1 } : {}),
      onPhase: (phase, fields) => this.deps.enrichDiagnostics().log(phase, fields),
      ...(this.deps.isMobile
        ? { maxInputBytes: (p: string) => p.toLowerCase().endsWith(".pdf") ? this.deps.mobilePdfMaxBytes : this.deps.mobileSourceNoteMaxBytes }
        : {}),
      load: async () => {
        try {
          if (await this.deps.vault.adapterExists(path)) return JSON.parse(await this.deps.vault.adapterRead(path)) as IndexData;
        } catch (e) {
          console.debug("Claude Companion: corrupt/missing semantic index, rebuilding", e);
        }
        return null;
      },
      save: async (data: IndexData) => {
        this.deps.enrichDiagnostics().log("serialize-start", { notes: Object.keys(data.notes).length });
        const json = JSON.stringify(data);
        this.deps.enrichDiagnostics().log("save-start", { bytes: json.length });
        await this.deps.vault.adapterWrite(path, json);
        this.deps.enrichDiagnostics().log("save-done", { bytes: json.length });
      },
    });
    this.indexerModel = model;
    return this._indexer;
  }

  async promptSemanticModelIfNeeded(): Promise<void> {
    const s = this.deps.settings();
    if (s.embeddingEngine !== "builtin") return;
    if (s.semanticModelPrompted) return;
    if (this.builtinEmbedder().backend() !== null) return;
    if (await this.builtinModelCached()) return;
    s.semanticModelPrompted = true;
    await this.deps.saveSettings();
    const model = builtinModelById(s.builtinEmbeddingModel);
    await new Promise<void>((resolve) => {
      this.deps.openChoiceModal<"download" | "skip">({
        title: "Set up semantic search",
        message:
          "Companion can index your vault on-device so vault search and related notes work by meaning, not just keywords. " +
          `This needs a one-time download (~${model.approxDownloadMB} MB from huggingface.co + ~23 MB ONNX runtime from cdn.jsdelivr.net; cached and fully offline afterwards). ` +
          "Until then, search stays keyword-only.",
        buttons: [
          { label: `Download (~${model.approxDownloadMB} MB)`, value: "download", cta: true },
          { label: "Not now", value: "skip" },
        ],
        fallback: "skip",
        onChoice: (c) => {
          if (c === "download") void this.downloadBuiltinModelAndIndex();
          resolve();
        },
      });
    });
  }

  async downloadBuiltinModelAndIndex(): Promise<void> {
    const model = builtinModelById(this.deps.settings().builtinEmbeddingModel);
    const activity = this.deps.activity();
    const activityId = activity.start({
      id: `embedding-download:${model.id}`,
      kind: "embedding-download",
      title: "Downloading embedding model",
      total: 100,
    });
    try {
      await this.builtinEmbedder().download((progress) => activity.update(activityId, {
        completed: progress.percent,
        total: 100,
        currentItem: progress.file,
      }));
      activity.finish(activityId, { completed: 100, succeeded: 1 });
      await this.rebuildSemanticIndex();
    } catch (error) {
      const recovery = this.embeddingRecovery(error);
      activity.fail(activityId, {
        failed: 1,
        technicalDetails: recovery.technicalDetails,
        recovery: recovery.actions,
        details: [{ label: model.hfRepo, message: recovery.message, state: "error" }],
      });
    }
  }

  private embeddingLabel(): string {
    const s = this.deps.settings();
    if (s.embeddingEngine === "builtin") {
      return `built-in (${builtinModelById(s.builtinEmbeddingModel).id.replace(/^builtin:/, "")})`;
    }
    if (s.embeddingEngine === "custom") {
      return `${s.openaiCompatEmbeddingModel || "custom endpoint"}`;
    }
    return s.embeddingModel;
  }

  invalidateIndexer(): void {
    this._indexer = null;
    this.indexerModel = null;
  }

  async semanticSearch(query: string, k: number, accept?: (path: string) => boolean): Promise<{ path: string; text: string }[]> {
    const ix = this.indexer();
    if (!ix) return [];
    if (!(await this.canEmbedWithoutDownload())) return [];
    try {
      const hits = await ix.search(query, k, accept);
      return hits.map((h) => ({ path: h.path, text: h.text }));
    } catch (e) {
      console.debug("Claude Companion: semantic search failed, falling back to keyword-only", e);
      return [];
    }
  }

  async relatedNotes(path: string, k: number, accept?: (path: string) => boolean): Promise<{ path: string; score: number }[]> {
    const ix = this.indexer();
    if (!ix) return [];
    const hits = await ix.related(path, k, accept);
    return hits.map((h) => ({ path: h.path, score: h.score }));
  }

  /** Tool and Bases-view neighbours; never starts an embedding-model download. */
  async relatedForTools(path: string, k: number, accept?: (path: string) => boolean): Promise<{ path: string; score: number }[]> {
    if (!(await this.canEmbedWithoutDownload())) return [];
    return this.relatedNotes(path, k, accept);
  }

  async rebuildSemanticIndex(): Promise<void> {
    const s = this.deps.settings();
    const modelId = embedderId(s.embeddingEngine, s.embeddingModel, s.builtinEmbeddingModel, s.openaiCompatEmbeddingModel);
    const activity = this.deps.activity();
    const activityId = activity.start({
      id: `semantic-index:${modelId}`,
      kind: "semantic-index",
      title: "Building semantic index",
    });
    if (!s.semanticEnabled) {
      activity.fail(activityId, {
        failed: 1,
        details: [{ label: "Semantic search", message: "Semantic search is turned off.", state: "error" }],
        recovery: [{ id: "embedding-settings", label: "Open embedding settings", kind: "settings" }],
      });
      return;
    }
    if (s.embeddingEngine === "ollama") {
      if (!this.deps.router().ollama.hasCredentials()) {
        const recovery = this.embeddingRecovery(new Error("Ollama connection unavailable"));
        activity.fail(activityId, {
          failed: 1,
          technicalDetails: recovery.technicalDetails,
          recovery: recovery.actions,
          details: [{ label: "Ollama", message: recovery.message, state: "error" }],
        });
        return;
      }
    } else if (!(await this.canEmbedWithoutDownload())) {
      const recovery = this.embeddingRecovery(new Error("Built-in embedding model not downloaded"));
      activity.fail(activityId, {
        failed: 1,
        technicalDetails: recovery.technicalDetails,
        recovery: recovery.actions,
        details: [{ label: "Built-in model", message: recovery.message, state: "error" }],
      });
      return;
    }
    const ix = this.indexer();
    if (!ix) return;
    let completed = 0;
    let total: number | undefined;
    try {
      const res = await ix.build({
        force: true,
        onProgress: (done, nextTotal) => {
          completed = done;
          total = nextTotal;
          activity.update(activityId, { completed: done, total: nextTotal });
        },
      });
      const summary = `${res.indexed} embedded, ${res.skipped} skipped, ${res.removed} pruned`;
      if (res.failureCount > 0) {
        const recovery = this.embeddingRecovery(new Error(res.failures[0]?.message ?? "Embedding failed"));
        activity.fail(activityId, {
          completed: total ?? completed,
          ...(total === undefined ? {} : { total }),
          succeeded: res.indexed,
          failed: res.failureCount,
          details: res.failures.map(({ path, message }) => ({ path, message })).map(({ path, message }) => ({ label: path, message: classifyEmbeddingFailure(new Error(message), {
            engine: s.embeddingEngine,
            isMobile: this.deps.isMobile,
            ...(s.embeddingEngine === "ollama" ? { endpoint: s.ollamaHost } : s.embeddingEngine === "custom" ? { endpoint: s.openaiCompatHost } : {}),
          }).technicalDetails, state: "error" as const })),
          technicalDetails: recovery.technicalDetails,
          recovery: recovery.actions,
        });
      } else {
        activity.finish(activityId, {
          completed: total ?? completed,
          ...(total === undefined ? {} : { total }),
          succeeded: res.indexed,
          details: [{ label: "Index ready", message: summary, state: "success" }],
        });
      }
    } catch (error) {
      console.error("[Claude Companion] semantic index build failed", error);
      const recovery = this.embeddingRecovery(error);
      activity.fail(activityId, {
        failed: 1,
        technicalDetails: recovery.technicalDetails,
        recovery: recovery.actions,
        details: [{ label: this.embeddingLabel(), message: recovery.message, state: "error" }],
      });
    }
  }

  async showSemanticIndexStatus(): Promise<void> {
    const s = this.deps.settings();
    if (!s.semanticEnabled) {
      this.deps.notice("Semantic search is off — turn it on in Companion settings to index your vault.", 7000);
      return;
    }
    const ix = this.indexer();
    if (!ix) {
      this.deps.notice("Semantic index is unavailable.", 6000);
      return;
    }
    try {
      let reach: string;
      let stats: { notes: number; chunks: number };
      if (s.embeddingEngine === "builtin") {
        stats = await ix.stats();
        const backend = this.builtinEmbedder().backend();
        reach = backend ? `model ready (${backend === "webgpu" ? "WebGPU" : "WASM"})` : "model not downloaded — download it in settings";
      } else {
        const [st, localOk] = await Promise.all([ix.stats(), this.deps.router().localAvailable()]);
        stats = st;
        reach = localOk ? "Ollama reachable" : "Ollama unreachable — searches fall back to keyword";
      }
      this.deps.notice(`Semantic index · ${stats.notes} notes, ${stats.chunks} chunks · "${this.embeddingLabel()}" · ${reach}`, 9000);
    } catch (e) {
      this.deps.notice(`Semantic index status unavailable: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  queueReindex(path: string): void {
    if (!this.deps.settings().semanticEnabled) return;
    this.reindexQueue.add(path);
    if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
    this.reindexTimer = window.setTimeout(() => void this.flushReindex(), 1500);
  }

  suspendReindex(): () => void {
    this.reindexSuspended++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reindexSuspended--;
      if (this.reindexSuspended === 0 && this.reindexQueue.size > 0) void this.flushReindex();
    };
  }

  private async flushReindex(): Promise<void> {
    if (this.reindexTimer !== null) { window.clearTimeout(this.reindexTimer); this.reindexTimer = null; }
    if (this.reindexSuspended > 0) return;
    const ix = this.indexer();
    if (!ix) {
      this.reindexQueue.clear();
      return;
    }
    if (!(await this.canEmbedWithoutDownload())) {
      this.reindexQueue.clear();
      if (!this.reindexPausedNotified) {
        this.reindexPausedNotified = true;
        this.deps.notice("Semantic reindex paused — download the built-in model in settings.");
      }
      return;
    }
    const paths = Array.from(this.reindexQueue);
    this.reindexQueue.clear();
    this.deps.enrichDiagnostics().log("reindex-flush-start", { n: paths.length });
    const entries = paths.flatMap((p) => {
      const f = this.deps.vault.getAbstractFileByPath(p);
      return f ? [{ path: p, mtime: f.stat.mtime, size: f.stat.size }] : [];
    });
    if (entries.length === 0) return;
    let failures: Array<{ path: string; error: unknown }>;
    try {
      failures = await ix.updateNotes(
        entries,
        this.deps.isMobile ? { yieldBetween: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)) } : {},
      );
    } catch (error) {
      this.deps.enrichDiagnostics().log("reindex-flush-rejected", { n: entries.length });
      failures = entries.map(({ path }) => ({ path, error }));
    }
    const activity = this.deps.activity();
    for (const { path: p, error } of failures) {
      console.error(`[Claude Companion] semantic reindex failed for ${p}`, error);
      const recovery = this.embeddingRecovery(error);
      const activityId = activity.start({
        id: `semantic-index:incremental:${p}`,
        kind: "semantic-index",
        title: "Semantic index needs attention",
      });
      activity.fail(activityId, {
        failed: 1,
        technicalDetails: recovery.technicalDetails,
        recovery: recovery.actions,
        details: [{ label: p, message: recovery.message, state: "error" }],
      });
    }
  }

  builtinEmbedder(): TransformersEmbedder {
    const model = builtinModelById(this.deps.settings().builtinEmbeddingModel);
    if (this._builtinEmbedder && this._builtinEmbedder.id !== model.id) {
      this._builtinEmbedder.terminate();
      this._builtinEmbedder = null;
      this._builtinModelCached = false;
    }
    if (!this._builtinEmbedder) this._builtinEmbedder = new TransformersEmbedder(() => createEmbedWorker() as unknown as WorkerLike, model);
    return this._builtinEmbedder;
  }

  async builtinModelCached(): Promise<boolean> {
    if (this._builtinModelCached) return true;
    const repo = builtinModelById(this.deps.settings().builtinEmbeddingModel).hfRepo;
    if (await hasCachedModel(typeof caches !== "undefined" ? caches : undefined, repo)) this._builtinModelCached = true;
    return this._builtinModelCached;
  }

  async clearBuiltinModel(): Promise<number> {
    this._builtinEmbedder?.terminate();
    this._builtinEmbedder = null;
    const deleted = await clearCachedModel(typeof caches !== "undefined" ? caches : undefined);
    this._builtinModelCached = false;
    return deleted;
  }

  async canEmbedWithoutDownload(): Promise<boolean> {
    if (this.deps.settings().embeddingEngine !== "builtin") return true;
    return this.builtinEmbedder().backend() !== null || (await this.builtinModelCached());
  }

  embeddingRecovery(error: unknown): EmbeddingRecovery {
    const s = this.deps.settings();
    const endpoint = s.embeddingEngine === "ollama"
      ? s.ollamaHost
      : s.embeddingEngine === "custom"
        ? s.openaiCompatHost
        : undefined;
    return classifyEmbeddingFailure(error, {
      engine: s.embeddingEngine,
      isMobile: this.deps.isMobile,
      ...(endpoint ? { endpoint } : {}),
    });
  }

  indexerHealth(): { embeddingHealth: string; indexHealth: string } {
    const s = this.deps.settings();
    return {
      embeddingHealth: s.semanticEnabled ? (this._indexer ? "Ready" : "Index not built yet") : "Disabled",
      indexHealth: this._indexer ? "Ready" : "Not built yet",
    };
  }

  onSettingsChanged(): void {
    const s = this.deps.settings();
    const activeEmbedder = embedderId(s.embeddingEngine, s.embeddingModel, s.builtinEmbeddingModel, s.openaiCompatEmbeddingModel);
    if (this.indexerModel !== activeEmbedder || (!s.semanticEnabled && this._indexer)) {
      this.invalidateIndexer();
    }
    if (s.embeddingEngine !== "builtin" && this._builtinEmbedder) {
      this._builtinEmbedder.terminate();
      this._builtinEmbedder = null;
    }
  }
}
