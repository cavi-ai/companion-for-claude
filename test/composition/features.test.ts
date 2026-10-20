import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deps = Record<string, (...args: never[]) => unknown> & Record<string, unknown>;

const { captured, capture } = vi.hoisted(() => {
  const store: Record<string, Deps | undefined> = {};
  return {
    captured: store,
    capture: (key: string) =>
      class {
        constructor(deps: Deps) {
          store[key] = deps;
        }
      },
  };
});

vi.mock("../../src/providers/utilityRouting", () => ({ UtilityRouting: capture("utilityRouting") }));
vi.mock("../../src/sources/clipperFeature", () => ({ ClipperFeature: capture("clipper") }));
vi.mock("../../src/onboarding/onboarding", () => ({ Onboarding: capture("onboarding") }));
vi.mock("../../src/enrich/noteFlows", () => ({ NoteFlows: capture("noteFlows") }));
vi.mock("../../src/view/companionShell", () => ({ CompanionShell: capture("shell") }));
vi.mock("../../src/research/researchFeature", () => ({ ResearchFeature: capture("research") }));
vi.mock("../../src/integrations/desktopFeature", () => ({ DesktopFeature: capture("desktop") }));
vi.mock("../../src/orders/ordersFeature", () => ({ OrdersFeature: capture("orders") }));
vi.mock("../../src/publish/publishFeature", () => ({ PublishFeature: capture("publishing") }));
vi.mock("../../src/view/workspaceViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/view/workspaceViews")>()),
  WorkspaceViews: capture("views"),
}));
vi.mock("../../src/living/feature", () => ({ LivingSources: capture("living") }));

import { Platform } from "obsidian";
import {
  buildClipperSetup,
  buildDesktopIntegrations,
  buildLivingSources,
  buildNoteFlows,
  buildOnboarding,
  buildOrders,
  buildPublishing,
  buildResearch,
  buildShell,
  buildUtilityRouting,
  buildWorkspaceViews,
} from "../../src/composition/features";
import { ARTIFACT_MAX_TOKENS } from "../../src/view/workspaceViews";

const call = <T>(key: string, name: string, ...args: unknown[]): T => (captured[key]![name] as (...a: unknown[]) => T)(...args);

function rig() {
  const m = {
    saveSettings: vi.fn(async () => undefined),
    persist: vi.fn(async () => undefined),
    router: vi.fn(() => "router"),
    secrets: vi.fn(() => "secrets"),
    ontology: vi.fn(() => "ontology"),
    semantic: vi.fn(() => "semantic"),
    memory: vi.fn(() => "memory"),
    enrichment: vi.fn(() => "enrichment"),
    conversations: vi.fn(() => "conversations"),
    standingOrders: vi.fn(() => "standingOrders"),
    clipperSetup: vi.fn(() => "clipperSetup"),
    research: vi.fn(() => "research"),
    orders: vi.fn(() => "orders"),
    chatLeafFor: vi.fn(() => "leaf"),
    mcpRunning: vi.fn(() => true),
    composeSystemPrompt: vi.fn(() => "prompt"),
    agentTools: vi.fn(() => "agentTools"),
    cliTurnRunner: vi.fn(async () => "runner"),
    registerEvent: vi.fn(),
    registerInterval: vi.fn(() => 7),
    open: vi.fn(async () => "opened"),
    activateView: vi.fn(async () => "activated"),
    syncInboxBadge: vi.fn(() => "synced"),
    companionChrome: vi.fn(() => "chrome"),
    openCompanionSettings: vi.fn(() => "settings-opened"),
    openObsidianCliSettings: vi.fn(() => "cli-settings-opened"),
  };
  const host = {
    app: { id: "app" },
    settings: { id: "settings" },
    activity: { id: "activity" },
    lastMarkdownFile: { id: "file-1" },
    saveSettings: m.saveSettings,
    persist: m.persist,
    router: m.router,
    secrets: m.secrets,
    ontology: m.ontology,
    semantic: m.semantic,
    memory: m.memory,
    enrichment: m.enrichment,
    conversations: m.conversations,
    standingOrders: m.standingOrders,
    clipperSetup: m.clipperSetup,
    research: m.research,
    orders: m.orders,
    chatLeafFor: m.chatLeafFor,
    mcpRunning: m.mcpRunning,
    composeSystemPrompt: m.composeSystemPrompt,
    agentTools: m.agentTools,
    cliTurnRunner: m.cliTurnRunner,
    registerEvent: m.registerEvent,
    registerInterval: m.registerInterval,
    desktopIntegrations: () => ({ open: m.open }),
    views: () => ({ activateView: m.activateView, syncInboxBadge: m.syncInboxBadge }),
    shell: () => ({
      companionChrome: m.companionChrome,
      openCompanionSettings: m.openCompanionSettings,
      openObsidianCliSettings: m.openObsidianCliSettings,
    }),
  };
  return { host: host as never, h: host, m };
}

beforeEach(() => {
  for (const key of Object.keys(captured)) captured[key] = undefined;
});

afterEach(() => {
  Platform.isMobile = false;
});

describe("buildUtilityRouting", () => {
  it("maps app, live settings, router and the platform flag", () => {
    const { host, h, m } = rig();
    buildUtilityRouting(host);
    expect(captured.utilityRouting!.app).toBe(h.app);
    h.settings = { id: "settings-2" };
    expect(call("utilityRouting", "settings")).toBe(h.settings);
    expect(call("utilityRouting", "router")).toBe("router");
    expect(m.router).toHaveBeenCalledTimes(1);
    expect(call("utilityRouting", "isMobile")).toBe(false);
    Platform.isMobile = true;
    expect(call("utilityRouting", "isMobile")).toBe(true);
  });
});

describe("buildClipperSetup", () => {
  it("maps settings, saveSettings, persist and activity", async () => {
    const { host, h, m } = rig();
    buildClipperSetup(host);
    expect(captured.clipper!.app).toBe(h.app);
    expect(call("clipper", "settings")).toBe(h.settings);
    await call("clipper", "saveSettings");
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(m.persist).not.toHaveBeenCalled();
    await call("clipper", "persist");
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(call("clipper", "activity")).toBe(h.activity);
  });
});

describe("buildOnboarding", () => {
  it("maps each lookup to its own host member", async () => {
    const { host, h, m } = rig();
    buildOnboarding(host);
    const d = captured.onboarding!;
    expect(d.app).toBe(h.app);
    expect(call("onboarding", "settings")).toBe(h.settings);
    await call("onboarding", "saveSettings");
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(call("onboarding", "router")).toBe("router");
    expect(call("onboarding", "secrets")).toBe("secrets");
    expect(call("onboarding", "ontology")).toBe("ontology");
    expect(call("onboarding", "semantic")).toBe("semantic");
    expect(await call("onboarding", "openDesktopIntegrations")).toBe("opened");
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(call("onboarding", "isMobile")).toBe(false);
    Platform.isMobile = true;
    expect(call("onboarding", "isMobile")).toBe(true);
  });
});

describe("buildNoteFlows", () => {
  it("maps settings, activity, router and ontology", () => {
    const { host, h } = rig();
    buildNoteFlows(host);
    expect(captured.noteFlows!.app).toBe(h.app);
    expect(call("noteFlows", "settings")).toBe(h.settings);
    expect(call("noteFlows", "activity")).toBe(h.activity);
    expect(call("noteFlows", "router")).toBe("router");
    expect(call("noteFlows", "ontology")).toBe("ontology");
  });
});

describe("buildWorkspaceViews", () => {
  it("maps research, orders and enrichment to their own members", () => {
    const { host, h, m } = rig();
    buildWorkspaceViews(host);
    expect(captured.views!.app).toBe(h.app);
    expect(call("views", "settings")).toBe(h.settings);
    expect(call("views", "research")).toBe("research");
    expect(call("views", "orders")).toBe("orders");
    expect(call("views", "enrichment")).toBe("enrichment");
    expect(m.research).toHaveBeenCalledTimes(1);
    expect(m.orders).toHaveBeenCalledTimes(1);
    expect(m.enrichment).toHaveBeenCalledTimes(1);
  });
});

describe("buildShell", () => {
  it("maps every lookup and forwards chatLeafFor with its argument", async () => {
    const { host, h, m } = rig();
    buildShell(host);
    expect(captured.shell!.app).toBe(h.app);
    expect(call("shell", "settings")).toBe(h.settings);
    await call("shell", "saveSettings");
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(call("shell", "activity")).toBe(h.activity);
    expect(call("shell", "router")).toBe("router");
    expect(call("shell", "semantic")).toBe("semantic");
    expect(call("shell", "memory")).toBe("memory");
    expect(call("shell", "clipperSetup")).toBe("clipperSetup");
    expect(call<{ open: unknown }>("shell", "desktopIntegrations").open).toBe(m.open);
    expect(call("shell", "standingOrders")).toBe("standingOrders");
    expect(call("shell", "conversations")).toBe("conversations");
    expect(call<{ activateView: unknown }>("shell", "views").activateView).toBe(m.activateView);
    expect(call("shell", "chatLeafFor", "conv-1")).toBe("leaf");
    expect(m.chatLeafFor).toHaveBeenCalledWith("conv-1");
  });
});

describe("buildResearch", () => {
  it("maps views, shell, the live last file, the build wiring and the token constant", async () => {
    const { host, h, m } = rig();
    const build = vi.fn(() => "build");
    buildResearch(host, { build: build as never });
    const d = captured.research!;
    expect(d.app).toBe(h.app);
    expect(call("research", "settings")).toBe(h.settings);
    expect(call("research", "activity")).toBe(h.activity);
    expect(call("research", "router")).toBe("router");
    expect(d.build).toBe(build);
    expect(await call("research", "activateView")).toBe("activated");
    expect(m.activateView).toHaveBeenCalledTimes(1);
    expect(call("research", "lastMarkdownFile")).toBe(h.lastMarkdownFile);
    h.lastMarkdownFile = { id: "file-2" };
    expect(call("research", "lastMarkdownFile")).toBe(h.lastMarkdownFile);
    expect(call("research", "companionChrome")).toBe("chrome");
    expect(call("research", "openCompanionSettings")).toBe("settings-opened");
    expect(m.openObsidianCliSettings).not.toHaveBeenCalled();
    expect(d.artifactMaxTokens).toBe(ARTIFACT_MAX_TOKENS);
  });
});

describe("buildDesktopIntegrations", () => {
  it("maps host members and takes the token and runtime loader from the wiring", async () => {
    const { host, h, m } = rig();
    const resolvedMcpToken = vi.fn(() => "token");
    const runtimeLoader = vi.fn(async () => ({ runtime: true }));
    buildDesktopIntegrations(host, { resolvedMcpToken, runtimeLoader: runtimeLoader as never });
    const d = captured.desktop!;
    expect(d.app).toBe(h.app);
    expect(call("desktop", "settings")).toBe(h.settings);
    await call("desktop", "saveSettings");
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(call("desktop", "router")).toBe("router");
    expect(d.resolvedMcpToken).toBe(resolvedMcpToken);
    expect(d.runtimeLoader).toBe(runtimeLoader);
    expect(call("desktop", "mcpRunning")).toBe(true);
    expect(m.mcpRunning).toHaveBeenCalledTimes(1);
    expect(call("desktop", "openCompanionSettings")).toBe("settings-opened");
    expect(call("desktop", "openObsidianCliSettings")).toBe("cli-settings-opened");
  });
});

describe("buildOrders", () => {
  it("forwards prompt, tool, runner, badge and registration calls with their arguments", async () => {
    const { host, h, m } = rig();
    const closeCliSession = vi.fn(async () => undefined);
    buildOrders(host, { closeCliSession });
    const d = captured.orders!;
    expect(d.app).toBe(h.app);
    expect(call("orders", "settings")).toBe(h.settings);
    expect(call("orders", "activity")).toBe(h.activity);
    await call("orders", "persist");
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(call("orders", "router")).toBe("router");
    const promptOpts = { agent: true };
    expect(call("orders", "composeSystemPrompt", promptOpts)).toBe("prompt");
    expect(m.composeSystemPrompt).toHaveBeenCalledWith(promptOpts);
    expect(call("orders", "agentTools")).toBe("agentTools");
    const turnOpts = { conversationId: "c1" };
    expect(await call("orders", "cliTurnRunner", turnOpts)).toBe("runner");
    expect(m.cliTurnRunner).toHaveBeenCalledWith(turnOpts);
    expect(d.closeCliSession).toBe(closeCliSession);
    expect(call("orders", "syncInboxBadge")).toBe("synced");
    const ref = { ref: true };
    call("orders", "registerEvent", ref);
    expect(m.registerEvent).toHaveBeenCalledWith(ref);
    expect(m.registerEvent.mock.contexts[0]).toBe(host);
    expect(call("orders", "registerInterval", 42)).toBe(7);
    expect(m.registerInterval).toHaveBeenCalledWith(42);
    expect(m.registerInterval.mock.contexts[0]).toBe(host);
  });
});

describe("buildPublishing", () => {
  it("maps settings, activity and persist", async () => {
    const { host, h, m } = rig();
    buildPublishing(host);
    expect(captured.publishing!.app).toBe(h.app);
    expect(call("publishing", "settings")).toBe(h.settings);
    expect(call("publishing", "activity")).toBe(h.activity);
    await call("publishing", "persist");
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(m.saveSettings).not.toHaveBeenCalled();
  });
});

describe("buildLivingSources", () => {
  it("reads the artifact folder live and resolves the model through utility routing", async () => {
    const resolveSession = vi.fn(async () => "selection");
    const host = { app: { id: "app" }, settings: { artifactFolder: "Claude/Artifacts" }, utilityRouting: () => ({ resolveSession }) };
    buildLivingSources(host as never);
    expect(captured.living!.app).toBe(host.app);
    expect(call("living", "folder")).toBe("Claude/Artifacts");
    host.settings.artifactFolder = "Views";
    expect(call("living", "folder")).toBe("Views");
    expect(await call("living", "selection")).toBe("selection");
    expect(resolveSession).toHaveBeenCalledTimes(1);
    // No DOM parser here, so video notes must carry their transcript.
    expect(captured.living!.transcript).toBeUndefined();
  });
});
