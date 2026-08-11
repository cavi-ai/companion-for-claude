import { App, FakeElement, Platform, TFile, clearNotices, getLastOpenedModal, getNoticeMessages } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { BuildRun } from "../../src/build/run";

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function pluginHarness() {
  const app = new App();
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  const activateBuildView = vi.fn(async () => null);
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app,
    settings: { ...structuredClone(DEFAULT_SETTINGS), mcpWriteFolder: "Claude/Builds" },
    convState: { conversations: [], activeId: null },
    researchDeskPreferences: {},
    buildRuns: {},
    activeBuildRunId: null,
    buildRunListeners: new Set(),
    buildCoordinators: new Map(),
    persist: vi.fn(async () => undefined),
    activateBuildView,
  });
  return { app, plugin, activateBuildView };
}

async function acceptBuild(pending: Promise<void>): Promise<void> {
  await flush();
  const modal = getLastOpenedModal();
  const buttons = (modal?.contentEl as unknown as FakeElement).querySelectorAll("button");
  buttons.find((button) => button.textContent.includes("Create"))?.dispatchEvent({ type: "click" });
  await pending;
}

describe("managed Build handoff", () => {
  beforeEach(() => { clearNotices(); Platform.isMobile = false; Platform.isDesktop = true; });

  it("creates spec and tracker documents plus a Ready desktop run without touching the clipboard", async () => {
    const { app, plugin, activateBuildView } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "# Feature\n\n- [ ] Parser\n- [ ] UI");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText } });

    const pending = plugin.handoffToBuild(plan);
    await acceptBuild(pending);

    const run = plugin.activeBuildRun();
    expect(run).toMatchObject({ title: "Feature", transport: "desktop", status: "ready" });
    expect(run?.tasks.map((task) => task.title)).toEqual(["Parser", "UI"]);
    expect(app.vault.getAbstractFileByPath("Claude/Builds/Feature — spec.md")).toBeInstanceOf(TFile);
    const tracker = app.vault.getAbstractFileByPath("Claude/Builds/Feature — tracker.md") as TFile;
    expect(tracker._content).toContain("**Status:** Ready");
    expect(tracker._content).not.toContain("claude -p");
    expect(writeText).not.toHaveBeenCalled();
    expect(activateBuildView).toHaveBeenCalledWith(run?.id);
    expect(getNoticeMessages()).toEqual([]);
  });

  it("creates a cloud run on mobile and explains setup in the runner rather than dispatching during Build", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Mobile.md", "- [ ] Cloud task");
    const request = vi.fn();
    Object.assign(plugin as unknown as Record<string, unknown>, { buildHttpRequest: request });
    await acceptBuild(plugin.handoffToBuild(plan));
    expect(plugin.activeBuildRun()).toMatchObject({ transport: "cloud", status: "ready" });
    expect(request).not.toHaveBeenCalled();
  });

  it("starts and completes a mobile task through the real coordinator and cloud executor wiring", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, plugin } = pluginHarness();
    Object.assign(plugin.settings, {
      cloudDispatchEnabled: true,
      cloudRoutineFireUrl: "https://api.anthropic.com/v1/claude_code/routines/r1/fire",
      cloudRoutineToken: "routine-token",
      cloudRoutineBetaHeader: "beta",
      cloudReplyRepo: "cavi-ai/vault",
      cloudReplyBranch: "main",
      cloudReplyFolder: "Claude/Replies",
      cloudReplyToken: "github-token",
    });
    let getCount = 0;
    const request = vi.fn(async (requestSpec: { method: string }) => {
      if (requestSpec.method === "POST") return { status: 200, text: JSON.stringify({ claude_code_session_id: "s1", claude_code_session_url: "https://claude.ai/code/s1" }) };
      getCount += 1;
      if (getCount === 1) return { status: 404, text: "{}" };
      return { status: 200, text: JSON.stringify({ path: "marker.md", sha: "sha", encoding: "base64", content: btoa("Cloud task done") }) };
    });
    Object.assign(plugin as unknown as Record<string, unknown>, { buildHttpRequest: request });
    await acceptBuild(plugin.handoffToBuild(app.vault.seed("Plans/Cloud.md", "- [ ] Cloud task")));

    await (plugin as unknown as { runActiveBuild(action: "start"): Promise<void> }).runActiveBuild("start");

    expect(plugin.activeBuildRun()).toMatchObject({ status: "completed", sessionUrl: "https://claude.ai/code/s1" });
    expect(request.mock.calls.filter(([requestSpec]) => requestSpec.method === "POST")).toHaveLength(1);
    const tracker = app.vault.getAbstractFileByPath("Claude/Builds/Cloud — tracker.md") as TFile;
    expect(tracker._content).toContain("**Status:** Complete");
    expect(tracker._content).toContain("Cloud task done");
  });

  it("restores persisted running work as interrupted instead of silently relaunching it", async () => {
    const { plugin } = pluginHarness();
    const running: BuildRun = {
      id: "saved", title: "Saved", specPath: "s", trackerPath: "t", transport: "desktop", status: "running",
      tasks: [{ title: "One", status: "running" }], activeTaskIndex: 0, log: "", createdAt: 1, updatedAt: 2,
    };
    Object.assign(plugin as unknown as Record<string, unknown>, {
      loadData: async () => ({ settings: {}, buildRuns: [running], activeBuildRunId: "saved" }),
    });
    await plugin.loadSettings();
    expect(plugin.activeBuildRun()).toMatchObject({ status: "interrupted", activeTaskIndex: null });
    expect(plugin.activeBuildRun()?.tasks[0]?.status).toBe("pending");
  });
});
