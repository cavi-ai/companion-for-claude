import type { ClaudeModel } from "../types";
import { CLAUDE_MODELS } from "./models";
import { mergeModelLists, parseModelList } from "./modelList";

export interface ModelRegistryDeps {
  /** Identity of the active direct-API credential, or null when models must not be fetched. */
  identity(): string | null;
  /** Raw Models API response body. */
  fetch(): Promise<unknown>;
}

/** The Claude model list for pickers: curated until a fetch for the current credential succeeds. */
export class ClaudeModelRegistry {
  private current: ClaudeModel[] = CLAUDE_MODELS;
  private loadedFor: string | null = null;
  private inflight: { identity: string; promise: Promise<boolean> } | null = null;

  constructor(private deps: ModelRegistryDeps) {}

  models(): ClaudeModel[] {
    return this.current;
  }

  /** Fetches once per credential; resolves true when the list changed. Failures keep the current list. */
  refresh(): Promise<boolean> {
    const identity = this.deps.identity();
    if (identity === null) {
      this.current = CLAUDE_MODELS;
      this.loadedFor = null;
      return Promise.resolve(false);
    }
    if (identity === this.loadedFor) return Promise.resolve(false);
    if (this.inflight?.identity === identity) return this.inflight.promise;
    const promise = this.load(identity);
    this.inflight = { identity, promise };
    return promise;
  }

  private async load(identity: string): Promise<boolean> {
    try {
      const fetched = parseModelList(await this.deps.fetch());
      if (this.deps.identity() !== identity || fetched.length === 0) return false;
      this.current = mergeModelLists(fetched, CLAUDE_MODELS);
      this.loadedFor = identity;
      return true;
    } catch {
      return false;
    } finally {
      if (this.inflight?.identity === identity) this.inflight = null;
    }
  }
}
