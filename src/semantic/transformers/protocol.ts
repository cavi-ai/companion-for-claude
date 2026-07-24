// Message protocol between TransformersEmbedder (main thread) and the
// embedding worker, plus request/response correlation. Pure — no obsidian,
// no worker APIs; the embedder feeds worker messages into RequestTracker.

export type WorkerRequest =
  | { id: number; type: "load" }
  | { id: number; type: "embed"; texts: string[] }
  | { id: number; type: "dispose" };

export type WorkerResponse =
  | { id: number; type: "result"; vectors: number[][]; backend?: string | undefined }
  | { id: number; type: "progress"; percent: number; file: string }
  | { id: number; type: "error"; message: string };

export interface ProgressEvent {
  percent: number;
  file: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: ((p: ProgressEvent) => void) | undefined;
}

/** Correlates worker responses to in-flight requests by id. */
export class RequestTracker {
  private next = 1;
  private pending = new Map<number, Pending>();

  create<T>(onProgress?: (p: ProgressEvent) => void): { id: number; promise: Promise<T> } {
    const id = this.next++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    });
    return { id, promise };
  }

  /** Feed one worker response in; unknown ids are ignored. */
  settle(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === "progress") {
      p.onProgress?.({ percent: msg.percent, file: msg.file });
      return; // not terminal
    }
    this.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg.vectors);
  }

  /** Fail every in-flight request (worker crash/terminate). */
  rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  size(): number {
    return this.pending.size;
  }
}
