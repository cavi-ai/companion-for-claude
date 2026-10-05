// Archive and fork flows behind the session dropdown. IO is injected so the
// ordering (distill first, open the tab last, store nothing on failure) is tested.

import type { ChatMessage } from "../types";
import type { Conversation } from "./store";
import { stripFrontmatter } from "../semantic/chunk";

export interface SessionActionsDeps {
  find(id: string): Conversation | undefined;
  archive(id: string): Promise<void>;
  fork(id: string): Promise<Conversation>;
  createSeeded(title: string, seed: ChatMessage, projectId?: string): Promise<Conversation>;
  /** Resolves the note path, or null when nothing was written. */
  distill(id: string): Promise<string | null>;
  /** The note's content, or null when it no longer exists. */
  readNote(path: string): Promise<string | null>;
  openInNewTab(conversationId: string): Promise<void>;
}

export class SessionActions {
  constructor(private readonly deps: SessionActionsDeps) {}

  /** Archive now; the summary is written in the background and a failure leaves the chat archived. */
  async archive(id: string): Promise<void> {
    await this.deps.archive(id);
    void this.deps.distill(id);
  }

  async fork(id: string): Promise<void> {
    if (!this.deps.find(id)) return;
    const fork = await this.deps.fork(id);
    await this.deps.openInNewTab(fork.id);
  }

  async forkFromSummary(id: string): Promise<void> {
    const source = this.deps.find(id);
    if (!source) return;
    let body = source.distilledNote ? await this.deps.readNote(source.distilledNote) : null;
    if (body === null) {
      const path = await this.deps.distill(id);
      if (path === null) return;
      body = await this.deps.readNote(path);
      if (body === null) return;
    }
    const seed: ChatMessage = { role: "user", display: `Continuing from: ${source.title}`, content: stripFrontmatter(body).trim() };
    const fork = await this.deps.createSeeded(`Fork of ${source.title}`, seed, source.projectId);
    await this.deps.openInNewTab(fork.id);
  }
}
