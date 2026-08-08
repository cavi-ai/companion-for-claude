import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  PluginSettingTab: class {},
}));

import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { EnrichDeps } from "../../src/sources/enrich";
import { App, clearNotices, FakeElement, getLastOpenedModal, getNoticeMessages, getNotices, Platform, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { ChoiceModal } from "../../src/view/ChoiceModal";
import { ProviderRouter, type ProviderSelection } from "../../src/providers/router";
import { AnthropicProvider } from "../../src/providers/anthropic";
import { InboxView, INBOX_VIEW_TYPE } from "../../src/view/InboxView";
import { summarizeAndTag } from "../../src/indexing/autoTagger";
import { OrganizeReviewModal } from "../../src/view/OrganizeReviewModal";

interface PrivateEnrich {
  enrichDeps(selection: ProviderSelection): EnrichDeps;
  resolvedEnrichDeps(): Promise<EnrichDeps>;
  sourceEnrichmentErrorHint(message: string): string | null;
  triageClippings(): Promise<void>;
  buildEnrichProposal(file: TFile, options: { rename: boolean; frontmatter: boolean; links: boolean; lint: boolean }): Promise<unknown>;
  organizeFolderFlow(folder: TFolder): Promise<void>;
  queueEnrich(file: TFile): void;
}

function pluginHarness(completeResolved: ReturnType<typeof vi.fn>): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS };
  Object.defineProperty(plugin, "router", {
    value: () => ({
      completeResolved,
    }),
  });
  return plugin;
}

function selection(): ProviderSelection {
  return {
    provider: { id: "ollama", label: "Ollama" } as ProviderSelection["provider"],
    model: "utility-model",
  };
}

function mobilePlugin(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): {
  app: App;
  file: TFile;
  plugin: ClaudeCompanionPlugin;
  router: ProviderRouter;
} {
  const app = new App();
  const file = app.vault.seed("Clippings/private.md", "Private note content.");
  app.workspace = {
    getLeaf: () => ({ openFile: async () => undefined }),
    getLeavesOfType: () => [],
  } as never;
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    apiKey: "sk-ant-api-test",
    sourceCaptureConsent: "allow",
    utilityBackend: "ollama",
    ollamaHost: "http://localhost:11434",
    ...overrides,
  };
  Object.assign(plugin, {
    app,
    enrichTimers: new Map<string, number>(),
    enrichRecentlyWritten: new Set<string>(),
    enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
  });
  const router = plugin.router();
  return { app, file, plugin, router };
}

function choose(label: string): void {
  const modal = getLastOpenedModal();
  const button = (modal?.contentEl as unknown as FakeElement | undefined)
    ?.querySelectorAll("button")
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  button?.dispatchEvent({ type: "click" });
}

async function settle(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

async function saveHarnessSettings(plugin: ClaudeCompanionPlugin): Promise<void> {
  Object.assign(plugin as unknown as Record<string, unknown>, {
    persist: async () => undefined,
    refreshViews: () => undefined,
    syncMcpServer: async () => undefined,
    invalidateIndexer: () => undefined,
  });
  await plugin.saveSettings();
}

afterEach(() => {
  Platform.isMobile = false;
  Platform.isDesktop = true;
  clearNotices();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("source enrichment wiring", () => {
  it("routes extraction through JSON mode with thinking disabled and a larger budget", async () => {
    // Regression: enrichment sent free-form 1024-token completions, so a
    // thinking utility model exhausted the budget on hidden reasoning and
    // replied empty — ExtractError "reply was not valid JSON".
    const complete = vi.fn(async () => ({ text: "{}", provider: selection().provider }));
    const selected = selection();
    const deps = (pluginHarness(complete) as unknown as PrivateEnrich).enrichDeps(selected);
    await deps.complete("sys", "user", { maxTokens: 4096, responseSchema: { type: "object" }, disableThinking: true });
    expect(complete).toHaveBeenCalledWith(selected, expect.objectContaining({
      maxTokens: 4096,
      responseFormat: "json",
      responseSchema: { type: "object" },
      thinking: { type: "disabled" },
    }));
  });

  it("leaves the default completion shape untouched when no opts are given", async () => {
    const complete = vi.fn(async () => ({ text: "ok", provider: selection().provider }));
    const selected = selection();
    const deps = (pluginHarness(complete) as unknown as PrivateEnrich).enrichDeps(selected);
    await deps.complete("sys", "user");
    expect(complete).toHaveBeenCalledWith(selected, { system: "sys", user: "user" });
  });

  it("uses one approved Claude selection for both completion and enrichedBy without changing settings", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { plugin, router } = mobilePlugin();
    const complete = vi.spyOn(router, "completeResolved").mockResolvedValue({ text: "{}", provider: router.anthropic });
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const pending = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await Promise.resolve();
    choose("Use Claude this session");
    const deps = await pending;
    await deps.complete("sys", "private note");

    expect(deps.enrichedBy).toBe("claude");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: router.anthropic, model: DEFAULT_SETTINGS.model }),
      { system: "sys", user: "private note" },
    );
    expect(plugin.settings.utilityBackend).toBe("ollama");

    await (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("keeps Inbox enrichment Notices inline while manual enrichment emits a finite Notice", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "https://models.example.com/v1",
      openaiCompatModel: "remote-model",
    });
    vi.spyOn(router.openaiCompat, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    await plugin.enrichInboxItem(file, { inline: true });
    expect(getNotices()).toEqual([]);

    const manual = app.vault.seed("Clippings/manual.md", "Manual clip");
    await plugin.enrichInboxItem(manual);
    const notice = getNotices().at(-1);
    expect(notice?.message).toContain("Typed source note");
    expect(notice?.timeout).toBe(5000);
  });

  it("keeps a successful public Inbox enrichment successful when one registered Inbox view cannot refresh", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "https://models.example.com/v1",
      openaiCompatModel: "remote-model",
    });
    vi.spyOn(router.openaiCompat, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));
    const broken = new InboxView(new WorkspaceLeaf(app), plugin);
    const healthy = new InboxView(new WorkspaceLeaf(app), plugin);
    const refreshFailure = new Error("closed Inbox leaf");
    vi.spyOn(broken, "render").mockRejectedValue(refreshFailure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    app.workspace = {
      getLeaf: () => ({ openFile: async () => undefined }),
      getLeavesOfType: (type: string) => type === INBOX_VIEW_TYPE
        ? [{ view: broken }, { view: healthy }]
        : [],
    } as never;

    await expect(plugin.enrichInboxItem(file, { inline: true })).resolves.toEqual({ status: "enriched" });

    expect(await app.vault.cachedRead(file)).toMatch(/source_enriched:\s*true/);
    expect((healthy.contentEl as unknown as FakeElement).querySelector(".cc-inbox-operation-status")?.textContent).toContain("Ready to enrich");
    expect(warning).toHaveBeenCalledWith("[companion] Inbox refresh failed", refreshFailure);
  });

  it("denial is session-cached and prevents a model call or note write", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const complete = vi.spyOn(router, "completeResolved");
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const pending = plugin.enrichInboxItem(file);
    await settle();
    choose("Don't send");
    await pending;

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/not approved.*LAN or remote endpoint/i);
    expect(getNoticeMessages().at(-1)).not.toMatch(/see console/i);
    await expect((plugin as unknown as PrivateEnrich).resolvedEnrichDeps()).rejects.toThrow(/not approved.*LAN or remote endpoint/i);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(plugin.settings.utilityBackend).toBe("ollama");
  });

  it("missing Claude credentials blocks mobile loopback enrichment without prompting", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { plugin, router } = mobilePlugin({ apiKey: "", oauthToken: "" });
    const complete = vi.spyOn(router, "completeResolved");
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    await expect((plugin as unknown as PrivateEnrich).resolvedEnrichDeps()).rejects.toThrow(/Anthropic credential.*LAN or remote endpoint/i);

    expect(opened).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("shows the actual mobile LAN utility backend in Inbox", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, plugin } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "http://192.168.1.24:1234",
      openaiCompatModel: "mlx-3b",
    });
    const view = new InboxView(new WorkspaceLeaf(app), plugin);

    await view.render();

    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-backend")?.textContent).toBe(
      "Utility: OpenAI-compatible endpoint · mlx-3b",
    );
  });

  it("attributes enrichment failures to the runtime-selected custom endpoint", () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { plugin } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "https://models.example.com",
      openaiCompatModel: "remote-model",
    });

    expect((plugin as unknown as PrivateEnrich).sourceEnrichmentErrorHint("failed to fetch")).toContain(
      "OpenAI-compatible endpoint at https://models.example.com",
    );
  });

  it("gates auto-tag utility completion through the same mobile consent boundary", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, plugin, router } = mobilePlugin();
    const ollamaComplete = vi.spyOn(router.ollama, "complete").mockResolvedValue("unsafe");
    const claudeComplete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const pending = summarizeAndTag(app, router, "Private note content.", []);
    await settle();

    expect(opened).toHaveBeenCalledTimes(1);
    choose("Don't send");
    await expect(pending).rejects.toThrow(/not approved.*LAN or remote endpoint/i);
    expect(ollamaComplete).not.toHaveBeenCalled();
    expect(claudeComplete).not.toHaveBeenCalled();
  });

  it("serializes concurrent mobile fallback consent and keeps denial authoritative", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { plugin, router } = mobilePlugin();
    const ollamaComplete = vi.spyOn(router.ollama, "complete").mockResolvedValue("unsafe");
    const claudeComplete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const first = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    const second = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    const settled = Promise.allSettled([first, second]);
    await settle();

    expect(opened).toHaveBeenCalledTimes(1);
    const buttons = (getLastOpenedModal()?.contentEl as unknown as FakeElement).querySelectorAll("button");
    const deny = buttons.find((button) => button.textContent === "Don't send");
    const allow = buttons.find((button) => button.textContent === "Use Claude this session");
    deny?.dispatchEvent({ type: "click" });
    allow?.dispatchEvent({ type: "click" });

    expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect((plugin as unknown as PrivateEnrich).resolvedEnrichDeps()).rejects.toThrow(/not approved/i);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(ollamaComplete).not.toHaveBeenCalled();
    expect(claudeComplete).not.toHaveBeenCalled();
  });

  it("shows an actionable Notice and performs no I/O for configured Claude without credentials", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin({ utilityBackend: "claude", apiKey: "", oauthToken: "" });
    const before = await app.vault.cachedRead(file);
    const complete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");

    await plugin.enrichInboxItem(file);

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/no Anthropic credential.*add a credential/i);
    expect(getNoticeMessages().at(-1)).not.toMatch(/see console/i);
  });

  it("attributes a provider failure to the pinned endpoint even if settings change in flight", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const original = "https://models.example.com/v1";
    const { plugin, router } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: original,
      openaiCompatModel: "remote-model",
    });
    let fail!: (reason: Error) => void;
    const response = new Promise<string>((_resolve, reject) => { fail = reject; });
    vi.spyOn(router.openaiCompat, "complete").mockReturnValue(response);

    const pending = plugin.enrichInboxItem((plugin.app.vault.getAbstractFileByPath("Clippings/private.md") as TFile));
    await settle();
    plugin.settings.openaiCompatHost = "https://changed.example.com/v1";
    fail(new Error("failed to fetch"));
    await pending;

    expect(getNoticeMessages().at(-1)).toContain(`OpenAI-compatible endpoint at ${original}`);
    expect(getNoticeMessages().at(-1)).not.toContain("changed.example.com");
  });

  it("redacts invalid endpoint credentials from the actionable Notice", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { file, plugin, router } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "http://alice:supersecret@models.example.com/v1",
      openaiCompatModel: "remote-model",
    });
    const complete = vi.spyOn(router.openaiCompat, "complete").mockResolvedValue("unsafe");

    await plugin.enrichInboxItem(file);

    expect(complete).not.toHaveBeenCalled();
    expect(getNoticeMessages().at(-1)).toContain("http://models.example.com/v1");
    expect(getNoticeMessages().at(-1)).toMatch(/invalid/i);
    expect(getNoticeMessages().join("\n")).not.toMatch(/alice|supersecret/i);
  });

  it("aborts clipping organization when enrichment fallback is denied instead of proposing default moves", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const review = vi.spyOn(OrganizeReviewModal.prototype, "open");
    const ollamaComplete = vi.spyOn(router.ollama, "complete").mockResolvedValue("unsafe");
    const claudeComplete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");

    const pending = plugin.organizeClippings();
    await settle();
    choose("Don't send");
    await pending;

    expect(review).not.toHaveBeenCalled();
    expect(ollamaComplete).not.toHaveBeenCalled();
    expect(claudeComplete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/organizing stopped.*not approved/i);
  });

  it("aborts triage on denied enrichment before excerpts reach the chat provider or a board is written", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, plugin, router } = mobilePlugin();
    const claudeComplete = vi.spyOn(router.anthropic, "complete").mockResolvedValue(
      JSON.stringify({ groups: [{ theme: "Private", paths: ["Clippings/private.md"], rationale: "private" }] }),
    );

    const pending = (plugin as unknown as PrivateEnrich).triageClippings();
    await settle();
    choose("Don't send");
    await pending;

    expect(claudeComplete).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath("Clippings/Triage.md")).toBeNull();
    expect(getNoticeMessages().at(-1)).toMatch(/triage failed.*not approved/i);
  });

  it("propagates denied utility tagging so note enrichment cannot continue into chat lint or review", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const claudeComplete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");

    const pending = (plugin as unknown as PrivateEnrich).buildEnrichProposal(file, {
      rename: true,
      frontmatter: true,
      links: true,
      lint: true,
    });
    await settle();
    choose("Don't send");

    await expect(pending).rejects.toThrow(/not approved/i);
    expect(claudeComplete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
  });

  it("aborts folder organization on denied utility inference instead of proposing misc moves", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { file, plugin, router } = mobilePlugin();
    const folder = Object.assign(new TFolder("Clippings"), { children: [file], name: "Clippings" });
    const review = vi.spyOn(OrganizeReviewModal.prototype, "open");
    const claudeComplete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");

    const pending = (plugin as unknown as PrivateEnrich).organizeFolderFlow(folder);
    await settle();
    choose("Don't send");
    await pending;

    expect(review).not.toHaveBeenCalled();
    expect(claudeComplete).not.toHaveBeenCalled();
    expect(getNoticeMessages().at(-1)).toMatch(/organize failed.*not approved/i);
  });

  it("discloses every session-global utility content category and the default Anthropic destination", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { plugin } = mobilePlugin();

    const pending = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    const rejected = expect(pending).rejects.toThrow(/not approved/i);
    await settle();
    const copy = (getLastOpenedModal()?.contentEl as unknown as FakeElement)
      .querySelector("p")?.textContent ?? "";

    choose("Don't send");
    await rejected;
    expect(copy).toMatch(/source enrichment/i);
    expect(copy).toMatch(/tagging.*organization/i);
    expect(copy).toMatch(/summaries.*frontmatter/i);
    expect(copy).toMatch(/memory consolidation.*session content/i);
    expect(copy).toMatch(/plugin session/i);
    expect(copy).toMatch(/Anthropic API at https:\/\/api\.anthropic\.com/i);
  });

  it("identifies the sanitized environment destination as an Anthropic-compatible gateway", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-gateway-copy");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example.com/anthropic/");
    const { plugin } = mobilePlugin({ authMode: "environment", apiKey: "", baseUrl: "" });

    const pending = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    const rejected = expect(pending).rejects.toThrow(/not approved/i);
    await settle();
    const copy = (getLastOpenedModal()?.contentEl as unknown as FakeElement)
      .querySelector("p")?.textContent ?? "";

    choose("Don't send");
    await rejected;
    expect(copy).toContain("Anthropic-compatible gateway at https://gateway.example.com/anthropic");
    expect(copy).not.toMatch(/Claude \(Anthropic API\)/i);
    expect(copy).not.toMatch(/sk-ant-api-gateway-copy|@/i);
  });

  it("rechecks current credentials after deferred consent and cannot use a stale credentialed router", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router: staleRouter } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const staleComplete = vi.spyOn(staleRouter.anthropic, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    const pending = plugin.enrichInboxItem(file);
    await settle();
    plugin.settings.apiKey = "";
    plugin.settings.oauthToken = "";
    await saveHarnessSettings(plugin);
    const currentRouter = plugin.router();
    const currentComplete = vi.spyOn(currentRouter.anthropic, "complete").mockResolvedValue("unsafe");
    choose("Use Claude this session");
    await pending;

    expect(staleComplete).not.toHaveBeenCalled();
    expect(currentComplete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/no Anthropic credential.*add a credential/i);
  });

  it("aborts deferred consent when the configured backend changes instead of calling either router", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router: staleRouter } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const opened = vi.spyOn(ChoiceModal.prototype, "open");
    const staleComplete = vi.spyOn(staleRouter.anthropic, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    const pending = plugin.enrichInboxItem(file);
    await settle();
    plugin.settings.utilityBackend = "custom";
    plugin.settings.openaiCompatHost = "https://current.example.com/v1";
    plugin.settings.openaiCompatModel = "current-model";
    await saveHarnessSettings(plugin);
    const currentRouter = plugin.router();
    const currentComplete = vi.spyOn(currentRouter.openaiCompat, "complete").mockResolvedValue("unsafe");
    choose("Use Claude this session");
    await pending;

    expect(staleComplete).not.toHaveBeenCalled();
    expect(currentComplete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/settings changed.*current.*custom.*retry/i);

    plugin.settings.utilityBackend = "ollama";
    plugin.settings.ollamaHost = "http://localhost:11434";
    await saveHarnessSettings(plugin);
    const retry = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();
    expect(opened).toHaveBeenCalledTimes(2);
    choose("Don't send");
    await expect(retry).rejects.toThrow(/not approved/i);
  });

  it("does not apply an Allow when the resolved fallback gateway changes while the modal is open", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-gateway-a");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-a.example.com/v1");
    const { app, file, plugin } = mobilePlugin({ authMode: "environment", apiKey: "", baseUrl: "" });
    const before = await app.vault.cachedRead(file);
    const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    const pending = plugin.enrichInboxItem(file);
    await settle();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-gateway-b");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-b.example.com/v1");
    choose("Use Claude this session");
    await pending;

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/gateway-b\.example\.com\/v1.*changed.*retry|changed.*gateway-b\.example\.com\/v1.*retry/i);
  });

  it("invalidates cached Allow and asks again after the fallback gateway and credential change", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-gateway-a");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-a.example.com/v1");
    const { app, file, plugin } = mobilePlugin({ authMode: "environment", apiKey: "", baseUrl: "" });
    const before = await app.vault.cachedRead(file);
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const first = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();
    choose("Use Claude this session");
    await first;

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-gateway-b");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-b.example.com/v1");
    const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("unsafe");

    const pending = plugin.enrichInboxItem(file);
    await settle();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    const copy = (getLastOpenedModal()?.contentEl as unknown as FakeElement)
      .querySelector("p")?.textContent ?? "";
    expect(copy).toContain("https://gateway-b.example.com/v1");
    choose("Don't send");
    await pending;

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
  });

  it("invalidates cached Allow after an API-key-only settings rotation", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin } = mobilePlugin({ apiKey: "sk-ant-api-settings-a" });
    const before = await app.vault.cachedRead(file);
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const first = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();
    choose("Use Claude this session");
    await first;

    plugin.settings.apiKey = "sk-ant-api-settings-b";
    await saveHarnessSettings(plugin);
    const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));
    const pending = plugin.enrichInboxItem(file);
    await settle();

    expect(opened).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    choose("Don't send");
    await pending;
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
  });

  it("does not apply an open consent modal after an OAuth-token-only settings rotation", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin } = mobilePlugin({
      authMode: "oauthToken",
      apiKey: "",
      oauthToken: "sk-ant-oat-settings-a",
    });
    const before = await app.vault.cachedRead(file);
    const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    const pending = plugin.enrichInboxItem(file);
    await settle();
    plugin.settings.oauthToken = "sk-ant-oat-settings-b";
    await saveHarnessSettings(plugin);
    choose("Use Claude this session");
    await pending;

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/changed.*retry/i);
  });

  it("invalidates cached Allow after a live environment key-only rotation", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-env-a");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example.com/v1");
    const { app, file, plugin } = mobilePlugin({ authMode: "environment", apiKey: "", baseUrl: "" });
    const before = await app.vault.cachedRead(file);
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const first = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();
    choose("Use Claude this session");
    await first;

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-env-b");
    const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));
    const pending = plugin.enrichInboxItem(file);
    await settle();

    expect(opened).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    choose("Don't send");
    await pending;
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
  });

  it("does not apply an open consent modal after a live environment token-only rotation", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "gateway-token-a");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example.com/v1");
    const { app, file, plugin } = mobilePlugin({ authMode: "environment", apiKey: "", baseUrl: "" });
    const before = await app.vault.cachedRead(file);
    const complete = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    const pending = plugin.enrichInboxItem(file);
    await settle();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "gateway-token-b");
    choose("Use Claude this session");
    await pending;

    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(getNoticeMessages().at(-1)).toMatch(/changed.*retry/i);
  });

  it("scopes cached Deny to the fallback auth context instead of the whole session", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { plugin } = mobilePlugin();
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const first = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();
    choose("Don't send");
    await expect(first).rejects.toThrow(/not approved/i);

    plugin.settings.authMode = "oauthToken";
    plugin.settings.apiKey = "";
    plugin.settings.oauthToken = "sk-ant-oat-test";
    await saveHarnessSettings(plugin);
    const retry = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();

    expect(opened).toHaveBeenCalledTimes(2);
    choose("Don't send");
    await expect(retry).rejects.toThrow(/not approved/i);
  });

  it("invalidates cached Deny when the environment gateway changes without a settings save", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-gateway-a");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-a.example.com/v1");
    const { plugin } = mobilePlugin({ authMode: "environment", apiKey: "", baseUrl: "" });
    const opened = vi.spyOn(ChoiceModal.prototype, "open");

    const first = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();
    choose("Don't send");
    await expect(first).rejects.toThrow(/not approved/i);

    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-b.example.com/v1");
    const retry = (plugin as unknown as PrivateEnrich).resolvedEnrichDeps();
    await settle();

    expect(opened).toHaveBeenCalledTimes(2);
    const copy = (getLastOpenedModal()?.contentEl as unknown as FakeElement)
      .querySelector("p")?.textContent ?? "";
    expect(copy).toContain("https://gateway-b.example.com/v1");
    choose("Don't send");
    await expect(retry).rejects.toThrow(/not approved/i);
  });

  it("invalidates and closes deferred fallback consent on unload before any call or write", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const complete = vi.spyOn(router.anthropic, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    const pending = plugin.enrichInboxItem(file);
    await settle();
    const modal = getLastOpenedModal() as (ReturnType<typeof getLastOpenedModal> & { closed?: boolean });
    const allow = (modal.contentEl as unknown as FakeElement)
      .querySelectorAll("button")
      .find((button) => button.textContent === "Use Claude this session");
    plugin.onunload();
    const closedOnUnload = modal.closed;
    allow?.dispatchEvent({ type: "click" });
    await pending;

    expect(closedOnUnload).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect((plugin as unknown as { mobileUtilityFallbackApproval?: unknown }).mobileUtilityFallbackApproval).toBeUndefined();
  });

  it("cancels queued automatic enrichment timers on unload", async () => {
    vi.useFakeTimers();
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin();
    const before = await app.vault.cachedRead(file);
    const opened = vi.spyOn(ChoiceModal.prototype, "open");
    const complete = vi.spyOn(router.anthropic, "complete").mockResolvedValue("unsafe");

    (plugin as unknown as PrivateEnrich).queueEnrich(file);
    plugin.onunload();
    await vi.advanceTimersByTimeAsync(2000);

    expect(opened).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears recently-written expiry timers on unload", async () => {
    vi.useFakeTimers();
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { file, plugin, router } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "https://models.example.com/v1",
      openaiCompatModel: "remote-model",
    });
    vi.spyOn(router.openaiCompat, "complete").mockResolvedValue(JSON.stringify({
      title: "Private note",
      site: "Vault",
      summary: "Private content.",
    }));

    await plugin.enrichInboxItem(file);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    plugin.onunload();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a provider result resolved after unload without a write or marker timer", async () => {
    vi.useFakeTimers();
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, file, plugin, router } = mobilePlugin({
      utilityBackend: "custom",
      openaiCompatHost: "https://models.example.com/v1",
      openaiCompatModel: "remote-model",
    });
    const before = await app.vault.cachedRead(file);
    let finish!: (reply: string) => void;
    const completion = new Promise<string>((resolve) => { finish = resolve; });
    const complete = vi.spyOn(router.openaiCompat, "complete").mockReturnValue(completion);
    const write = vi.spyOn(app.vault, "process");

    const pending = plugin.enrichInboxItem(file);
    await settle();
    expect(complete).toHaveBeenCalledTimes(1);
    plugin.onunload();
    const lifecycle = plugin as unknown as { utilityLifecycleEnded: boolean; utilityLifecycleGeneration: number };
    lifecycle.utilityLifecycleEnded = false;
    lifecycle.utilityLifecycleGeneration += 1;
    finish(JSON.stringify({ title: "Private note", site: "Vault", summary: "Private content." }));
    await pending;

    const state = plugin as unknown as {
      enrichRecentlyWritten: Set<string>;
      enrichRecentlyWrittenExpiryTimers: Map<string, number>;
    };
    expect(await app.vault.cachedRead(file)).toBe(before);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(state.enrichRecentlyWritten.size).toBe(0);
    expect(state.enrichRecentlyWrittenExpiryTimers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
