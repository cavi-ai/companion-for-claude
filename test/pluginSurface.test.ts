import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../src/activity/store";
import { ConversationsController } from "../src/conversations/controller";
import { SessionActions } from "../src/conversations/sessionActions";
import ClaudeCompanionPlugin from "../src/main";
import { DesktopFeature } from "../src/integrations/desktopFeature";
import { Onboarding } from "../src/onboarding/onboarding";
import { OrdersFeature } from "../src/orders/ordersFeature";
import { UtilityRouting } from "../src/providers/utilityRouting";
import { PublishFeature } from "../src/publish/publishFeature";
import { ResearchFeature } from "../src/research/researchFeature";
import { SemanticController } from "../src/semantic/controller";
import { ClipperFeature } from "../src/sources/clipperFeature";
import { buildPlugin } from "./fakes/plugin";
import { NoteFlows } from "../src/enrich/noteFlows";
import { CompanionShell } from "../src/view/companionShell";
import { WorkspaceViews } from "../src/view/workspaceViews";

const FORWARDERS = [
  "listConversations", "getActiveConversation", "beginActiveConversationTurn", "registerActiveChatTurn", "stopActiveChatTurn",
  "saveChatEditProposal", "clearChatEditProposal", "completeActiveConversationTurn", "interruptActiveConversationTurn",
  "capActiveConversationTurn", "activeConversationId", "setActiveConversation", "startNewConversation", "setChatProject",
  "deleteConversation", "renameConversation", "unarchiveConversation", "distillConversation", "archiveConversation",
  "forkConversation", "forkFromSummary",
  "embeddingRecovery", "builtinEmbedder", "builtinModelCached", "clearBuiltinModel", "indexer", "promptSemanticModelIfNeeded",
  "downloadBuiltinModelAndIndex", "invalidateIndexer", "semanticSearch", "relatedNotes", "relatedForTools",
  "rebuildSemanticIndex", "showSemanticIndexStatus", "queueReindex", "suspendReindex", "canEmbedWithoutDownload",
  "sourceEnrichmentBackendLabel", "providerErrorHint", "isUtilityLifecycleActive", "assertUtilityLifecycleActive",
  "sourceEnrichmentErrorHint", "resolveUtilitySelectionForSession", "runtimeUtilitySelection", "utilityUnavailableMessage",
  "askMobileUtilityFallback", "exportClipperTemplates", "clipperSetupNeeded", "openClipperSetup", "queueClipperVerification",
  "clipperTemplatesStale", "clipperStatus", "seedOntology", "credentialSetupInputs", "runFirstRun", "continueOnboarding",
  "openSetupWizard", "runFirstRunPrompts", "loadOntologyOnStart", "offerOntologySeed", "offerDesktopIntegrations",
  "scheduleOntologyReload",
  "syncPlanBuildActions", "markNoteAsPlan", "createResearchActions", "openResearchPath", "askResearch", "openDiscovery",
  "refreshResearchViews", "requireResearchSelection", "researchRewriteText", "startResearchFromActiveNote", "discoveryCoordinator",
  "createDiscoveryCoordinator", "releaseDiscoveryCoordinator", "retainDiscoveryCoordinator", "buildDiscoveryCoordinator",
  "clearDiscoveryCache", "activateResearchDesk", "scheduleResearchRefresh", "researchRepository", "generatePlanFromNote",
  "handoffToBuild", "activeBuildRun", "activateBuildView",
  "openDesktopIntegrations", "configureClaudeDesktopBridge", "claudeCodeBridgeInput", "createDesktopIntegrationController",
  "openDesktopIntegrationsModal", "mobileDesktopIntegrationsController", "confirmDesktopIntegration",
  "templatesRoot", "readVaultNote", "loadStandingOrders", "runStandingOrder", "listQueuedEdits", "queueReviewDeps",
  "reviewQueuedEdit", "discardQueuedEdit", "onOrderQueueChanged", "scheduleOrdersRefresh", "startStandingOrders",
  "createStandingOrder", "pickStandingOrder",
  "publishedItems", "unpublishItem", "testPublishToken", "cloud", "dispatchCloudSession", "testCloudReplies", "pullCloudReplies",
  "linkCandidates", "linkedTargets", "reviewLinkSuggestions", "reviewInboxLinkSuggestions", "enrichNoteFlow", "enrichFolderFlow",
  "buildEnrichProposal", "applyEnrichDecision", "organizeFolderFlow", "suggestFrontmatterForActiveNote",
  "generateArtifactFromContext",
  "companionChrome", "quickOptionsSnapshot", "saveQuickOption", "runQuickOption", "openCompanionSettings",
  "openObsidianCliSettings", "openSettingsTab", "runActivityRecovery",
  "activateView", "openNewChatTab", "companionWorkspaceContext", "askCompanionAboutProject", "activateMemoryView",
  "activateInboxView", "activateSystem", "refreshMemoryView", "activateRelatedView", "enrichInboxItem", "inboxPendingCount",
  "scheduleInboxBadgeSync", "syncInboxBadge", "openWorkflowPicker", "runWorkflow",
  "listVaultSessions", "openSessionPicker", "captureSession", "consolidateMemory", "captureLatestSession",
  "captureConversation", "reingestSession",
];

function builtPlugin(): ClaudeCompanionPlugin {
  return buildPlugin({
    convState: { conversations: [], activeId: null },
    _activity: new ActivityStore({ successRetentionMs: 60_000 }),
  });
}

describe("plugin conversation surface", () => {
  it("builds the conversation and session controllers", () => {
    const plugin = builtPlugin();
    expect(plugin.conversations()).toBeInstanceOf(ConversationsController);
    expect(plugin.sessionActions()).toBeInstanceOf(SessionActions);
  });

  it("returns the same controller on every call", () => {
    const plugin = builtPlugin();
    expect(plugin.conversations()).toBe(plugin.conversations());
    expect(plugin.sessionActions()).toBe(plugin.sessionActions());
  });

  it("builds one semantic controller", () => {
    const plugin = builtPlugin();
    expect(plugin.semantic()).toBeInstanceOf(SemanticController);
    expect(plugin.semantic()).toBe(plugin.semantic());
  });

  it("builds one utility routing, clipper setup and onboarding module", () => {
    const plugin = builtPlugin();
    expect(plugin.utilityRouting()).toBeInstanceOf(UtilityRouting);
    expect(plugin.utilityRouting()).toBe(plugin.utilityRouting());
    expect(plugin.clipperSetup()).toBeInstanceOf(ClipperFeature);
    expect(plugin.clipperSetup()).toBe(plugin.clipperSetup());
    expect(plugin.onboarding()).toBeInstanceOf(Onboarding);
    expect(plugin.onboarding()).toBe(plugin.onboarding());
  });

  it("builds one research, desktop integrations, orders and publishing module", () => {
    const plugin = builtPlugin();
    expect(plugin.research()).toBeInstanceOf(ResearchFeature);
    expect(plugin.research()).toBe(plugin.research());
    expect(plugin.desktopIntegrations()).toBeInstanceOf(DesktopFeature);
    expect(plugin.desktopIntegrations()).toBe(plugin.desktopIntegrations());
    expect(plugin.orders()).toBeInstanceOf(OrdersFeature);
    expect(plugin.orders()).toBe(plugin.orders());
    expect(plugin.publishing()).toBeInstanceOf(PublishFeature);
    expect(plugin.publishing()).toBe(plugin.publishing());
  });

  it("builds one note flows, workspace views and companion shell module", () => {
    const plugin = builtPlugin();
    expect(plugin.noteFlows()).toBeInstanceOf(NoteFlows);
    expect(plugin.noteFlows()).toBe(plugin.noteFlows());
    expect(plugin.views()).toBeInstanceOf(WorkspaceViews);
    expect(plugin.views()).toBe(plugin.views());
    expect(plugin.shell()).toBeInstanceOf(CompanionShell);
    expect(plugin.shell()).toBe(plugin.shell());
  });

  it("serves the controller accessors from their modules", () => {
    const plugin = builtPlugin();
    expect(plugin.standingOrders()).toBe(plugin.orders().standingOrders());
    expect(plugin.publish()).toBe(plugin.publishing().publish());
  });

  it("reports the device chat idle without constructing the client", () => {
    const plugin = builtPlugin();
    expect(plugin.deviceChatBusy()).toBe(false);
    expect((plugin as unknown as { _deviceChat?: unknown })._deviceChat).toBeUndefined();
    Object.assign(plugin, { _deviceChat: { busy: () => true } });
    expect(plugin.deviceChatBusy()).toBe(true);
  });

  it.each(FORWARDERS)("has no %s forwarder", (name) => {
    expect(name in ClaudeCompanionPlugin.prototype).toBe(false);
  });
});

describe("plugin unload timers", () => {
  afterEach(() => vi.useRealTimers());

  it("clears the pending onboarding, view, research and orders timers", () => {
    vi.useFakeTimers();
    const plugin = builtPlugin();
    plugin.onboarding().scheduleOntologyReload();
    plugin.views().scheduleInboxBadgeSync();
    plugin.research().scheduleResearchRefresh("Research/A/Project.md");
    (plugin.orders() as unknown as { scheduleOrdersRefresh(): void }).scheduleOrdersRefresh();
    expect(vi.getTimerCount()).toBe(4);
    plugin.onunload();
    expect(vi.getTimerCount()).toBe(0);
  });
});
