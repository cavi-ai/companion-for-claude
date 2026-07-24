// Main-thread half of the built-in engine: lazy worker spawn, load-once
// then embed, request correlation, crash recovery. The Worker is injected
// (main.ts creates it from the inlined bundle via a Blob URL) so this file
// stays pure and unit-testable.

import type { Embedder } from "../embedder";
import { BUILTIN_EMBEDDING_MODEL } from "./model";
import { RequestTracker, type ProgressEvent, type WorkerRequest, type WorkerResponse } from "./protocol";

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export class TransformersEmbedder implements Embedder {
  readonly id = BUILTIN_EMBEDDING_MODEL.id;

  private worker: WorkerLike | null = null;
  private tracker = new RequestTracker();
  private loaded: Promise<void> | null = null;
  private _backend: string | null = null;

  constructor(private createWorker: () => WorkerLike) {}

  /** "webgpu" | "wasm" once loaded; null before. */
  backend(): string | null {
    return this._backend;
  }

  /** Explicit download/warm-up with progress (settings button). */
  download(onProgress?: (p: ProgressEvent) => void): Promise<void> {
    return this.ensureLoaded(onProgress);
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ensureLoaded();
    // terminate() may race the await continuation: don't resurrect a worker
    // with an un-loaded embed.
    if (!this.loaded) throw new Error("embedding worker terminated");
    const req = this.tracker.create<number[][]>();
    this.post({ id: req.id, type: "embed", texts });
    return req.promise;
  }

  /** Kill the worker (unload / engine switch). Safe to call repeatedly. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    this._backend = null;
    this.tracker.rejectAll(new Error("embedding worker terminated"));
  }

  private ensureLoaded(onProgress?: (p: ProgressEvent) => void): Promise<void> {
    if (!this.loaded) {
      const req = this.tracker.create<number[][]>(onProgress);
      this.post({ id: req.id, type: "load" });
      const loadPromise = req.promise.then(() => undefined).catch((e: unknown) => {
        if (this.loaded === loadPromise) this.loaded = null; // allow retry after a failed load
        throw e;
      });
      // Prevent vitest/node unhandled-rejection noise when a crash rejects
      // this promise but nobody is currently awaiting it (e.g. embed()'s
      // caller already got its own rejection from tracker.rejectAll()).
      loadPromise.catch(() => {});
      this.loaded = loadPromise;
    }
    return this.loaded;
  }

  private post(msg: WorkerRequest): void {
    if (!this.worker) {
      const w = this.createWorker();
      // Handlers are scoped to this worker's lifetime: a stale, abandoned
      // worker firing late must not disturb the replacement's state.
      w.onmessage = (e) => {
        if (this.worker !== w) return;
        const data = e.data as WorkerResponse;
        if (data.type === "result" && data.backend) this._backend = data.backend;
        this.tracker.settle(data);
      };
      w.onerror = () => {
        if (this.worker !== w) return;
        w.terminate(); // an unhandled exception doesn't kill the worker; don't leak it
        this.worker = null;
        this.loaded = null;
        this._backend = null;
        this.tracker.rejectAll(new Error("embedding worker crashed"));
      };
      this.worker = w;
    }
    this.worker.postMessage(msg);
  }
}
