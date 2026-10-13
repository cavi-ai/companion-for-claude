// The plugin capabilities each chat module uses; a module typed by its host cannot reach the rest of the plugin.

import type ClaudeCompanionPlugin from "../../main";
import type { CommandActions } from "../../commands/definitions";
import type { ConversationsController } from "../../conversations/controller";
import type { SessionActions } from "../../conversations/sessionActions";
import type { SemanticController } from "../../semantic/controller";
import type { PluginSlashAction } from "../slashCommands";

export type HeaderConversations = Pick<ConversationsController, "delete" | "getActive" | "list" | "rename" | "setActive" | "unarchive">;

export type ChatConversations = HeaderConversations & Pick<
  ConversationsController,
  | "activeId" | "beginTurn" | "capTurn" | "clearEditProposal" | "completeTurn" | "interruptTurn"
  | "registerTurn" | "saveEditProposal" | "setProject" | "stopTurn"
>;

export type ChatSessions = Pick<SessionActions, "archive" | "distill" | "fork" | "forkFromSummary">;

export type ComposerHost = Pick<ClaudeCompanionPlugin, "captureWebPage" | "router" | "saveSettings" | "settings">;

export type TranscriptHost = Pick<ClaudeCompanionPlugin, "research" | "router" | "settings" | "views">;

export type SetupCardHost = Pick<ClaudeCompanionPlugin, "onboarding" | "router" | "saveSettings" | "secrets" | "settings">;

/** The chat view's own needs plus everything it hands to the composer, header, transcript, and setup card. */
export type ChatViewHost = ComposerHost & TranscriptHost & SetupCardHost & Omit<HeaderHost, "conversations"> & {
  conversations: () => ChatConversations;
  semantic: () => Pick<SemanticController, "semanticSearch">;
  commandActions: () => Pick<CommandActions, PluginSlashAction>;
} & Pick<
  ClaudeCompanionPlugin,
  | "agentTools" | "callExternalMcp" | "chatProjectFor" | "cliTurnRunner" | "composeSystemPrompt"
  | "externalMcpTools" | "interruptCliTurn" | "listChatProjects" | "loadedOntology" | "memory" | "promptTemplates"
  | "research" | "router" | "saveSettings" | "settings" | "turnService" | "views"
>;

export type HeaderHost = { conversations: () => HeaderConversations; sessionActions: () => ChatSessions } & Pick<
  ClaudeCompanionPlugin,
  | "composeSystemPrompt" | "deleteActiveConversation" | "mcpStats" | "memory" | "publishing" | "research" | "router"
  | "saveSettings" | "setMcpEnabled" | "settings" | "shell" | "views"
>;
