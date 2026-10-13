import type { App, EventRef } from "obsidian";
import type { ChatViewHost } from "./hosts";
import type { ChatSession } from "./chatSession";
import type { ClaimAtSource } from "../../context/atMention";
import { isProjectChange, type ChatProject } from "../../projects/model";

export type ProjectBindingHost = Pick<ChatViewHost, "research" | "listChatProjects" | "chatProjectFor" | "conversations">;

export interface ProjectBindingDeps {
  /** The conversation this view shows. */
  conversationId(): string | null;
  /** Mirror the bound project in the composer pill and the header label. */
  showProject(project: ChatProject | null): void;
  updateUsageBar(): void;
}

/** Holds the chat project a conversation is scoped to, plus the claims and projects the "@" picker offers; it never touches the DOM. */
export class ChatProjectBinding {
  /** Research claims offered by the "@"/"#" pickers, refreshed when a research note changes. */
  private cachedClaims: ClaimAtSource[] = [];
  private claimReloadGeneration = 0;
  private claimReloadTimer: number | null = null;
  /** Chat projects offered by the "@" picker, refreshed alongside claims. */
  private cachedProjects: ChatProject[] = [];
  /** A project chosen before the first send (no conversation yet); applied once `run()` creates one. */
  private pendingProjectId: string | null = null;

  constructor(
    private app: App,
    private plugin: ProjectBindingHost,
    private chat: ChatSession,
    private deps: ProjectBindingDeps,
  ) {}

  claims(): ClaimAtSource[] { return this.cachedClaims; }

  projectOptions(): { id: string; name: string }[] {
    return this.cachedProjects.map((p) => ({ id: p.id, name: p.name }));
  }

  // Research claims for the "@"/"#" pickers: load now, refresh on the same
  // signal the research views use to know a research note changed. Chat
  // projects reload alongside, but only for a chat-project note or a research Project.md.
  watch(register: (ref: EventRef) => void): void {
    void this.reloadClaims();
    void this.reloadProjects();
    register(this.app.metadataCache.on("changed", (file) => { this.scheduleReloadClaims(); if (isProjectChange(file.path, this.app.metadataCache.getFileCache(file)?.frontmatter)) void this.reloadProjects(); }));
    register(this.app.vault.on("create", (file) => { if (file.path.endsWith(".md")) this.scheduleReloadClaims(); if (isProjectChange(file.path)) void this.reloadProjects(); }));
    register(this.app.vault.on("delete", (file) => { if (file.path.endsWith(".md")) this.scheduleReloadClaims(); if (isProjectChange(file.path)) void this.reloadProjects(); }));
    register(this.app.vault.on("rename", (file, oldPath) => { if (file.path.endsWith(".md") || oldPath.endsWith(".md")) this.scheduleReloadClaims(); if (isProjectChange(file.path) || isProjectChange(oldPath)) void this.reloadProjects(); }));
  }

  dispose(): void {
    this.claimReloadGeneration++;
    if (this.claimReloadTimer !== null) {
      window.clearTimeout(this.claimReloadTimer);
      this.claimReloadTimer = null;
    }
  }

  forget(): void {
    this.pendingProjectId = null;
  }

  clear(): void {
    this.forget();
    this.setLocalProject(null);
  }

  /** Persist a project chosen before the first send onto the conversation `run()` just created. */
  async bindPending(conversationId: string): Promise<void> {
    if (this.pendingProjectId === null) return;
    await this.plugin.conversations().setProject(conversationId, this.pendingProjectId);
    this.pendingProjectId = null;
  }

  /** Sync the bound project (and the pill/header label) to the current conversation's persisted projectId. */
  async refreshCurrent(): Promise<void> {
    let project: ChatProject | null = null;
    try {
      project = await this.plugin.chatProjectFor(this.deps.conversationId());
    } catch {
      // Conversation/registry lookup unavailable — no project for this turn.
    }
    this.setLocalProject(project);
  }

  /** Apply a project chosen from the "@" menu or the "Chat: choose project" command. */
  async applyChosen(project: ChatProject): Promise<void> {
    const conversationId = this.deps.conversationId();
    if (conversationId === null) {
      // No conversation yet — hold the choice until run() creates one.
      this.pendingProjectId = project.id;
      this.setLocalProject(project);
      return;
    }
    await this.plugin.conversations().setProject(conversationId, project.id);
    await this.refreshCurrent();
    this.deps.updateUsageBar();
  }

  /** "@" project item / pill remove-×: `id` null clears the project. */
  chooseById(id: string | null): void {
    if (id === null) {
      void (async () => {
        const conversationId = this.deps.conversationId();
        if (conversationId) {
          await this.plugin.conversations().setProject(conversationId, null);
          await this.refreshCurrent();
        } else { this.pendingProjectId = null; this.setLocalProject(null); }
        this.deps.updateUsageBar();
      })();
      return;
    }
    const project = this.cachedProjects.find((p) => p.id === id);
    if (project) void this.applyChosen(project);
  }

  /** Coalesces rapid vault/metadata events into one reloadClaims() after the last one. */
  private scheduleReloadClaims(): void {
    if (this.claimReloadTimer !== null) window.clearTimeout(this.claimReloadTimer);
    this.claimReloadTimer = window.setTimeout(() => {
      this.claimReloadTimer = null;
      void this.reloadClaims();
    }, 500);
  }

  /** Re-read every active research project's claims for the "@"/"#" pickers. */
  private async reloadClaims(): Promise<void> {
    const generation = ++this.claimReloadGeneration;
    const claims: ClaimAtSource[] = [];
    try {
      const repo = this.plugin.research().researchRepository();
      const projects = (await repo.listProjects()).filter((p) => p.status === "active");
      for (const project of projects) {
        const snapshot = await repo.loadProject(project.path);
        for (const claim of snapshot.claims) claims.push({ path: claim.path, label: claim.proposition, project: claim.project });
      }
    } catch {
      // Research repository unavailable — claims stay empty.
    }
    if (generation !== this.claimReloadGeneration) return;
    this.cachedClaims = claims;
  }

  /** Re-read every available chat project (notes + Research Desk) for the "@" picker. */
  private async reloadProjects(): Promise<void> {
    try {
      this.cachedProjects = await this.plugin.listChatProjects();
    } catch {
      // Registry unavailable — projects list stays as it was.
    }
  }

  /** Set the bound project and its pill/header label, without touching persisted storage. */
  private setLocalProject(project: ChatProject | null): void {
    this.chat.project = project;
    this.deps.showProject(project);
  }
}
