import { App, FileSystemAdapter } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { McpHttpServer } from "../src/mcp/server";
import { CliSession } from "../src/cli/session";
import { DEFAULT_SETTINGS } from "../src/types";
import { SetupWizardModal } from "../src/view/SetupWizardModal";

afterEach(() => vi.restoreAllMocks());

const runtime = () => ({
  find: async () => ({ executable: "claude", version: "2.1.257" }),
  probe: async () => ({ loggedIn: true, method: "claude.ai" }),
  writeSystemPromptFile: async () => "/tmp/p.md",
  removeFile: vi.fn(async () => undefined),
  spawn: vi.fn(() => { throw new Error("spawn is stubbed at the session level"); }),
});

function plugin(rt: ReturnType<typeof runtime>): ClaudeCompanionPlugin {
  const app = new App();
  (app.vault as unknown as { adapter: unknown }).adapter = new FileSystemAdapter("/vault");
  const p = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(p as unknown as Record<string, unknown>, {
    app,
    settings: { ...structuredClone(DEFAULT_SETTINGS), chatBackend: "claude-cli", apiKey: "" },
    convState: { conversations: [{ id: "c1", title: "t", createdAt: 1, updatedAt: 1, messages: [] }, { id: "c2", title: "t", createdAt: 1, updatedAt: 1, messages: [] }], activeId: "c1" },
    cliSessions: new Map(),
    cliPromptFiles: new Set(),
    utilityLifecycleEnded: false,
    utilityLifecycleGeneration: 0,
    mcpLifecycleGeneration: 0,
    mcpLifecycleEnded: false,
    _router: null,
    persist: async () => undefined,
    mcpSyncChain: Promise.resolve(),
    cliRuntime: () => rt,
    composeSystemPrompt: () => "sys",
    agentTools: () => ({ definitions: () => [], call: async () => "" }),
  });
  return p;
}

describe("plugin Claude CLI lifecycle", () => {
  it("starts a scoped chat bridge per session, reuses a session per conversation, and tears everything down on unload", async () => {
    const start = vi.spyOn(McpHttpServer.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(McpHttpServer.prototype, "isRunning").mockReturnValue(true);
    vi.spyOn(McpHttpServer.prototype, "address").mockReturnValue({ port: 4321 });
    const stop = vi.spyOn(McpHttpServer.prototype, "stop").mockResolvedValue(undefined);
    const run = vi.spyOn(CliSession.prototype, "run").mockResolvedValue({ text: "", trace: [] });
    const close = vi.spyOn(CliSession.prototype, "close").mockResolvedValue(undefined);
    const rt = runtime();
    const p = plugin(rt);
    await p.router().claudeCli.refresh();
    const deps = { confirmWrite: async () => true, proposeEdit: async () => "" };
    const a = await p.cliTurnRunner({ conversationId: "c1", planMode: false, agentMode: true, model: "claude-sonnet-5", deps, transcript: "" });
    const b = await p.cliTurnRunner({ conversationId: "c1", planMode: false, agentMode: true, model: "claude-sonnet-5", deps, transcript: "" });
    expect(a).toBe(b);
    expect(start).toHaveBeenCalledOnce();
    const c = await p.cliTurnRunner({ conversationId: "c2", planMode: false, agentMode: true, model: "claude-sonnet-5", deps, transcript: "" });
    expect(c).not.toBe(a);
    const off = await p.cliTurnRunner({ conversationId: "c1", planMode: false, agentMode: false, model: "claude-sonnet-5", deps, transcript: "" });
    expect(off).not.toBe(a);
    expect(start).toHaveBeenCalledTimes(3);
    expect(run).not.toHaveBeenCalled();
    expect((p as unknown as { convState: { conversations: { id: string; cliSessionId?: string }[] } }).convState.conversations.every((x) => typeof x.cliSessionId === "string")).toBe(true);
    p.onunload();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(3));
    expect(rt.removeFile).toHaveBeenCalledTimes(3);
  });

  it("passes the conversation's chat project into the CLI system prompt", async () => {
    vi.spyOn(McpHttpServer.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(McpHttpServer.prototype, "address").mockReturnValue({ port: 4321 });
    vi.spyOn(McpHttpServer.prototype, "stop").mockResolvedValue(undefined);
    const rt = runtime();
    const seenPrompts: string[] = [];
    rt.writeSystemPromptFile = async (text: string) => { seenPrompts.push(text); return "/tmp/p.md"; };
    const p = plugin(rt);
    (p as unknown as { convState: { conversations: { id: string; projectId?: string }[] } }).convState.conversations[0]!.projectId = "Claude/Projects/Widgets.md";
    Object.assign(p as unknown as Record<string, unknown>, {
      composeSystemPrompt: ClaudeCompanionPlugin.prototype.composeSystemPrompt,
      listChatProjects: async () => [{ id: "Claude/Projects/Widgets.md", name: "Widgets", folder: null, pinned: [], instructions: "Ship widgets on time.", source: "note" as const }],
    });
    await p.router().claudeCli.refresh();
    const deps = { confirmWrite: async () => true, proposeEdit: async () => "" };
    await p.cliTurnRunner({ conversationId: "c1", planMode: false, agentMode: true, model: "claude-sonnet-5", deps, transcript: "" });
    expect(seenPrompts[0]).toContain("Chat project: Widgets");
    expect(seenPrompts[0]).toContain("Ship widgets on time.");
  });

  it("keeps write confirmation bound to the conversation whose CLI called it", async () => {
    vi.spyOn(McpHttpServer.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(McpHttpServer.prototype, "address").mockReturnValue({ port: 4321 });
    vi.spyOn(McpHttpServer.prototype, "stop").mockResolvedValue(undefined);
    const p = plugin(runtime());
    await p.router().claudeCli.refresh();
    const seen: string[] = [];
    const deps = (id: string, allowed: boolean) => ({
      confirmWrite: async () => { seen.push(id); return allowed; },
      proposeEdit: async () => id,
    });

    await p.cliTurnRunner({ conversationId: "c1", planMode: false, agentMode: true, model: "claude-sonnet-5", deps: deps("c1", false), transcript: "" });
    await p.cliTurnRunner({ conversationId: "c2", planMode: false, agentMode: true, model: "claude-sonnet-5", deps: deps("c2", true), transcript: "" });

    type Registry = { call(name: string, args: Record<string, unknown>): Promise<string> };
    type Entry = { bridge: McpHttpServer };
    const sessions = (p as unknown as { cliSessions: Map<string, Entry> }).cliSessions;
    const c1 = sessions.get("c1")!;
    const c2 = sessions.get("c2")!;
    expect(c1.bridge).not.toBe(c2.bridge);
    const registry = (c1.bridge as unknown as { tools: Registry }).tools;
    const result = JSON.parse(await registry.call("permission_prompt", {
      tool_name: "mcp__obsidian-vault__note_create",
      input: { title: "Scoped" },
      tool_use_id: "toolu_1",
    })) as { behavior: string };
    expect(result.behavior).toBe("deny");
    expect(seen).toEqual(["c1"]);
  });

  it("spawns a fresh session and keeps history when the previous one is spent", async () => {
    vi.spyOn(McpHttpServer.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(McpHttpServer.prototype, "isRunning").mockReturnValue(true);
    vi.spyOn(McpHttpServer.prototype, "address").mockReturnValue({ port: 4321 });
    vi.spyOn(McpHttpServer.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(CliSession.prototype, "run").mockResolvedValue({ text: "", trace: [] });
    vi.spyOn(CliSession.prototype, "close").mockResolvedValue(undefined);
    const rt = runtime();
    const p = plugin(rt);
    await p.router().claudeCli.refresh();
    const deps = { confirmWrite: async () => true, proposeEdit: async () => "" };
    const opts = { conversationId: "c1", planMode: false, agentMode: true, model: "claude-sonnet-5", deps, transcript: "" };
    const a = await p.cliTurnRunner(opts);
    type ConvOut = { convState: { conversations: { id: string; cliSessionId?: string; cliSessionHistory?: string[] }[] } };
    const firstConvo = () => (p as unknown as ConvOut).convState.conversations.find((c) => c.id === "c1")!;
    const firstId = firstConvo().cliSessionId;
    expect(typeof firstId).toBe("string");
    // The process is spent (interrupted or exited); run() is mocked so `child` stays null and interrupt() would no-op — spy isClosed directly instead.
    vi.spyOn(CliSession.prototype, "isClosed").mockReturnValue(true);
    const b = await p.cliTurnRunner(opts);
    expect(b).not.toBe(a);
    expect(firstConvo().cliSessionId).not.toBe(firstId);
    expect(firstConvo().cliSessionHistory).toEqual([firstId]);
  });

  it("refuses to build a runner when the CLI is not signed in", async () => {
    const rt = runtime();
    rt.probe = async () => ({ loggedIn: false, method: "" });
    const p = plugin(rt);
    await p.router().claudeCli.refresh();
    await expect(p.cliTurnRunner({ conversationId: "c1", planMode: false, agentMode: true, model: "m", deps: { confirmWrite: async () => true, proposeEdit: async () => "" }, transcript: "" })).rejects.toThrow(/not signed in/);
  });

  it("keeps the sign-in probe across a settings save (router rebuild reuses the same ClaudeCliProvider)", async () => {
    const rt = runtime();
    const p = plugin(rt);
    const before = p.router().claudeCli;
    await before.refresh();
    expect(before.hasCredentials()).toBe(true);
    await p.saveSettings();
    const after = p.router().claudeCli;
    expect(after).toBe(before);
    expect(after.hasCredentials()).toBe(true);
  });

  // Only the "connect" step is left in play: index/vault-tools are pre-satisfied
  // so a wizard opening can only be explained by the credential race.
  function forWizardRace(p: ClaudeCompanionPlugin): void {
    p.settings = { ...p.settings, ontologyEnabled: false, semanticEnabled: false, desktopIntegrationsOffered: true, setupWizardDone: false };
  }
  type RunFirstRun = { runFirstRun(cliProbe?: Promise<unknown>): Promise<void> };

  it("awaits the in-flight Claude Code probe before planning the wizard: signed-in resolves to no wizard", async () => {
    const rt = runtime();
    rt.probe = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { loggedIn: true, method: "claude.ai" };
    };
    const p = plugin(rt);
    forWizardRace(p);
    const openSpy = vi.spyOn(SetupWizardModal.prototype, "open").mockImplementation(() => undefined);
    const cliProbe = p.router().claudeCli.refresh();
    await (p as unknown as RunFirstRun).runFirstRun(cliProbe);
    expect(openSpy).not.toHaveBeenCalled();
    expect(p.router().claudeCli.hasCredentials()).toBe(true);
  });

  it("still opens no wizard when the probe settles not signed in and no API key is set — the chat setup card covers it", async () => {
    const rt = runtime();
    rt.probe = async () => ({ loggedIn: false, method: "" });
    const p = plugin(rt);
    forWizardRace(p);
    const openSpy = vi.spyOn(SetupWizardModal.prototype, "open").mockImplementation(() => undefined);
    const cliProbe = p.router().claudeCli.refresh();
    await (p as unknown as RunFirstRun).runFirstRun(cliProbe);
    expect(openSpy).not.toHaveBeenCalled();
    expect(p.router().claudeCli.hasCredentials()).toBe(false);
  });

  it("opens one wizard when layout-ready and the chat setup card both continue onboarding", async () => {
    const rt = runtime();
    const p = plugin(rt);
    forWizardRace(p);
    p.settings = { ...p.settings, desktopIntegrationsOffered: false, semanticEnabled: true, semanticModelPrompted: false };
    await p.router().claudeCli.refresh();
    const openSpy = vi.spyOn(SetupWizardModal.prototype, "open");
    await Promise.all([p.continueOnboarding(), p.continueOnboarding()]);
    expect(openSpy).toHaveBeenCalledTimes(1);
    (openSpy.mock.contexts[0] as SetupWizardModal).close();
    p.openSetupWizard();
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("no credential → layout-ready opens no wizard", async () => {
    const rt = runtime();
    rt.probe = async () => ({ loggedIn: false, method: "" });
    const p = plugin(rt);
    forWizardRace(p);
    const openSpy = vi.spyOn(SetupWizardModal.prototype, "open").mockImplementation(() => undefined);
    await (p as unknown as RunFirstRun).runFirstRun();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
