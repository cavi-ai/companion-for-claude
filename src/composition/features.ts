// Wires the feature objects: utility routing, clipper, onboarding, note flows, views, shell, research, desktop integrations, orders, publishing and living views.

import { Platform, requestUrl } from "obsidian";
import { NoteFlows } from "../enrich/noteFlows";
import { DesktopFeature, type DesktopFeatureDeps } from "../integrations/desktopFeature";
import { LivingSources } from "../living/feature";
import { fetchVideoTranscript } from "../living/youtube";
import { requestUrlFetch } from "../web/requestFetch";
import type ClaudeCompanionPlugin from "../main";
import { Onboarding } from "../onboarding/onboarding";
import { OrdersFeature, type OrdersFeatureDeps } from "../orders/ordersFeature";
import { UtilityRouting } from "../providers/utilityRouting";
import { PublishFeature } from "../publish/publishFeature";
import { ResearchFeature, type ResearchFeatureDeps } from "../research/researchFeature";
import { ClipperFeature } from "../sources/clipperFeature";
import { CompanionShell } from "../view/companionShell";
import { ARTIFACT_MAX_TOKENS, WorkspaceViews } from "../view/workspaceViews";

export type UtilityRoutingHost = Pick<ClaudeCompanionPlugin, "app" | "router" | "settings">;

export function buildUtilityRouting(host: UtilityRoutingHost): UtilityRouting {
  return new UtilityRouting({
    app: host.app,
    settings: () => host.settings,
    router: () => host.router(),
    isMobile: () => Platform.isMobile,
  });
}

export type ClipperSetupHost = Pick<ClaudeCompanionPlugin, "activity" | "app" | "persist" | "saveSettings" | "settings">;

export function buildClipperSetup(host: ClipperSetupHost): ClipperFeature {
  return new ClipperFeature({
    app: host.app,
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    persist: () => host.persist(),
    activity: () => host.activity,
  });
}

export type OnboardingHost = Pick<
  ClaudeCompanionPlugin,
  "app" | "desktopIntegrations" | "ontology" | "router" | "saveSettings" | "secrets" | "semantic" | "settings"
>;

export function buildOnboarding(host: OnboardingHost): Onboarding {
  return new Onboarding({
    app: host.app,
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    router: () => host.router(),
    secrets: () => host.secrets(),
    ontology: () => host.ontology(),
    semantic: () => host.semantic(),
    openDesktopIntegrations: () => host.desktopIntegrations().open(),
    isMobile: () => Platform.isMobile,
  });
}

export type NoteFlowsHost = Pick<ClaudeCompanionPlugin, "activity" | "app" | "ontology" | "router" | "settings">;

export function buildNoteFlows(host: NoteFlowsHost): NoteFlows {
  return new NoteFlows({
    app: host.app,
    settings: () => host.settings,
    activity: () => host.activity,
    router: () => host.router(),
    ontology: () => host.ontology(),
  });
}

export type WorkspaceViewsHost = Pick<ClaudeCompanionPlugin, "app" | "enrichment" | "orders" | "research" | "settings">;

export function buildWorkspaceViews(host: WorkspaceViewsHost): WorkspaceViews {
  return new WorkspaceViews({
    app: host.app,
    settings: () => host.settings,
    research: () => host.research(),
    orders: () => host.orders(),
    enrichment: () => host.enrichment(),
  });
}

export type ShellHost = Pick<
  ClaudeCompanionPlugin,
  | "activity"
  | "app"
  | "chatLeafFor"
  | "clipperSetup"
  | "conversations"
  | "desktopIntegrations"
  | "memory"
  | "router"
  | "saveSettings"
  | "semantic"
  | "settings"
  | "standingOrders"
  | "views"
>;

export function buildShell(host: ShellHost): CompanionShell {
  return new CompanionShell({
    app: host.app,
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    activity: () => host.activity,
    router: () => host.router(),
    semantic: () => host.semantic(),
    memory: () => host.memory(),
    clipperSetup: () => host.clipperSetup(),
    desktopIntegrations: () => host.desktopIntegrations(),
    standingOrders: () => host.standingOrders(),
    conversations: () => host.conversations(),
    views: () => host.views(),
    chatLeafFor: (conversationId) => host.chatLeafFor(conversationId),
  });
}

export type ResearchHost = Pick<
  ClaudeCompanionPlugin,
  "activity" | "app" | "lastMarkdownFile" | "router" | "settings" | "shell" | "views"
>;

export interface ResearchWiring {
  build: ResearchFeatureDeps["build"];
}

export function buildResearch(host: ResearchHost, wiring: ResearchWiring): ResearchFeature {
  return new ResearchFeature({
    app: host.app,
    settings: () => host.settings,
    activity: () => host.activity,
    router: () => host.router(),
    build: wiring.build,
    activateView: () => host.views().activateView(),
    lastMarkdownFile: () => host.lastMarkdownFile,
    companionChrome: () => host.shell().companionChrome(),
    openCompanionSettings: () => host.shell().openCompanionSettings(),
    artifactMaxTokens: ARTIFACT_MAX_TOKENS,
  });
}

export type DesktopIntegrationsHost = Pick<ClaudeCompanionPlugin, "app" | "mcpRunning" | "router" | "saveSettings" | "settings" | "shell">;

export interface DesktopIntegrationsWiring {
  resolvedMcpToken: DesktopFeatureDeps["resolvedMcpToken"];
  runtimeLoader: DesktopFeatureDeps["runtimeLoader"];
}

export function buildDesktopIntegrations(host: DesktopIntegrationsHost, wiring: DesktopIntegrationsWiring): DesktopFeature {
  return new DesktopFeature({
    app: host.app,
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    router: () => host.router(),
    resolvedMcpToken: wiring.resolvedMcpToken,
    mcpRunning: () => host.mcpRunning(),
    openCompanionSettings: () => host.shell().openCompanionSettings(),
    openObsidianCliSettings: () => host.shell().openObsidianCliSettings(),
    runtimeLoader: wiring.runtimeLoader,
  });
}

export type OrdersHost = Pick<
  ClaudeCompanionPlugin,
  | "activity"
  | "agentTools"
  | "app"
  | "cliTurnRunner"
  | "composeSystemPrompt"
  | "persist"
  | "registerEvent"
  | "registerInterval"
  | "router"
  | "settings"
  | "views"
>;

export interface OrdersWiring {
  closeCliSession: OrdersFeatureDeps["closeCliSession"];
}

export function buildOrders(host: OrdersHost, wiring: OrdersWiring): OrdersFeature {
  return new OrdersFeature({
    app: host.app,
    settings: () => host.settings,
    activity: () => host.activity,
    persist: () => host.persist(),
    router: () => host.router(),
    composeSystemPrompt: (opts) => host.composeSystemPrompt(opts),
    agentTools: () => host.agentTools(),
    cliTurnRunner: (opts) => host.cliTurnRunner(opts),
    closeCliSession: wiring.closeCliSession,
    syncInboxBadge: () => host.views().syncInboxBadge(),
    registerEvent: (ref) => host.registerEvent(ref),
    registerInterval: (id) => host.registerInterval(id),
  });
}

export type PublishingHost = Pick<ClaudeCompanionPlugin, "activity" | "app" | "persist" | "settings">;

export function buildPublishing(host: PublishingHost): PublishFeature {
  return new PublishFeature({
    app: host.app,
    settings: () => host.settings,
    activity: () => host.activity,
    persist: () => host.persist(),
  });
}

export type LivingSourcesHost = Pick<ClaudeCompanionPlugin, "app" | "settings" | "utilityRouting">;

export function buildLivingSources(host: LivingSourcesHost): LivingSources {
  return new LivingSources({
    app: host.app,
    folder: () => host.settings.artifactFolder,
    selection: () => host.utilityRouting().resolveSession(),
    // Page parsing needs a DOM; without one, video notes must carry their transcript.
    ...(typeof DOMParser === "undefined" ? {} : {
      transcript: (url: string) => fetchVideoTranscript(url, {
        fetchHtml: async (target) => {
          const response = await requestUrl({ url: target, method: "GET", throw: false });
          if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
          return response.text;
        },
        parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
        fetch: requestUrlFetch(requestUrl),
      }),
    }),
  });
}
