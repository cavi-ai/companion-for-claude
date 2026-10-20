// Wires the conversation cluster: the store controller, distillation, session actions and the turn service.

import { Notice, Platform, TFile } from "obsidian";
import { saveSummaryNote } from "../artifacts/artifactStore";
import { ChatTurnService } from "../chat/turnService";
import { resolveCitationPath } from "../chat/provenance";
import { shouldNotifyTurnComplete } from "../chat/turnNotice";
import { ConversationsController, type ConversationsControllerDeps } from "../conversations/controller";
import { DistillController } from "../conversations/distillController";
import { SessionActions } from "../conversations/sessionActions";
import type ClaudeCompanionPlugin from "../main";
import { CHAT_VIEW_TYPE } from "../view/ChatView";

export type ChatHost = Pick<ClaudeCompanionPlugin, "app" | "activity" | "persist" | "router" | "settings">;

export interface ChatWiring {
  state: ConversationsControllerDeps["state"];
  onUnattachedTurnDone(conversationId: string, title: string): void;
}

export interface ChatCluster {
  conversations(): ConversationsController;
  distiller(): DistillController;
  sessionActions(): SessionActions;
  turnService(): ChatTurnService;
}

export function buildChat(host: ChatHost, wiring: ChatWiring): ChatCluster {
  let conversationsController: ConversationsController | undefined;
  let distillController: DistillController | undefined;
  let sessionActionsInstance: SessionActions | undefined;
  let turnServiceInstance: ChatTurnService | undefined;

  const cluster: ChatCluster = {
    conversations: () => conversationsController ??= new ConversationsController({
      state: wiring.state,
      persist: () => host.persist(),
      activity: () => host.activity,
      settings: () => host.settings,
      resolveCitation: linkpath => resolveCitationPath(linkpath, host.app.vault.getFiles().map(file => file.path)).path,
    }),
    distiller: () => distillController ??= new DistillController({
      get: (id) => cluster.conversations().list().find((c) => c.id === id),
      complete: async (req) => (await host.router().complete("utility", req)).text,
      exists: (path) => host.app.vault.getAbstractFileByPath(path) instanceof TFile,
      resolveLink: (link) => host.app.metadataCache.getFirstLinkpathDest(link.replace(/\.md$/, ""), "")?.path ?? (host.app.vault.getAbstractFileByPath(link) instanceof TFile ? link : null),
      write: async (existing, folder, title, content, created) => {
        const file = existing === null ? null : host.app.vault.getAbstractFileByPath(existing);
        if (file instanceof TFile) {
          await host.app.vault.modify(file, content);
          return file.path;
        }
        return (await saveSummaryNote(host.app, folder, title, content, created)).path;
      },
      setDistilledNote: (id, path) => cluster.conversations().setDistilledNote(id, path),
      notice: (text) => new Notice(text),
      settings: () => host.settings,
    }),
    sessionActions: () => sessionActionsInstance ??= new SessionActions({
      find: (id) => cluster.conversations().list().find((c) => c.id === id),
      archive: (id) => cluster.conversations().archive(id),
      fork: (id) => cluster.conversations().fork(id),
      createSeeded: (title, seed, projectId) => cluster.conversations().createSeeded(title, seed, projectId),
      distill: (id) => cluster.distiller().distill(id),
      readNote: async (path) => {
        const file = host.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? host.app.vault.cachedRead(file) : null;
      },
      openInNewTab: async (conversationId) => {
        const { workspace } = host.app;
        const leaf = workspace.getLeaf("tab");
        await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true, state: { conversationId } });
        await workspace.revealLeaf(leaf);
      },
    }),
    turnService: () => {
      if (turnServiceInstance) return turnServiceInstance;
      const service = new ChatTurnService();
      service.onUnattachedDone(({ conversationId, title, result }) => {
        if (!shouldNotifyTurnComplete(host.settings.notifyOnTurnComplete, result)) return;
        if (Platform.isMobile) new Notice(`Claude finished: ${title}`);
        wiring.onUnattachedTurnDone(conversationId, title);
      });
      turnServiceInstance = service;
      return service;
    },
  };
  return cluster;
}
