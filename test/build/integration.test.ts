import { App, FakeElement, Platform, TFile, clearNotices, getLastOpenedModal, getNoticeMessages } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlugin } from "../fakes/plugin";
import { DEFAULT_SETTINGS } from "../../src/types";
import { CLOUD_ROUTINE_BETA_HEADER } from "../../src/cloud/routines";
import type { BuildRun } from "../../src/build/run";

const originalTimezone = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function pluginHarness() {
  const app = new App();
  const activateBuildView = vi.fn(async () => null);
  const plugin = buildPlugin({
    settings: { ...structuredClone(DEFAULT_SETTINGS), mcpWriteFolder: "Claude/Builds" },
    convState: { conversations: [], activeId: null },
    persist: vi.fn(async () => undefined),
  }, app);
  Object.assign(plugin.research() as unknown as Record<string, unknown>, { activateBuildView });
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

  it("keeps earlier build documents and user edits when creating another build", async () => {
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] First task");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    const first = structuredClone(plugin.research().activeBuildRun()!);
    const spec = app.vault.getAbstractFileByPath(first.specPath) as TFile;
    const tracker = app.vault.getAbstractFileByPath(first.trackerPath) as TFile;
    await app.vault.append(spec, "\nUser spec notes.");
    await app.vault.append(tracker, "\nUser tracker notes.");
    const before = [spec._content, tracker._content];
    await app.vault.modify(plan, "- [ ] Revised task");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    const second = plugin.research().activeBuildRun()!;
    expect(second.specPath).not.toBe(first.specPath);
    expect(second.trackerPath).not.toBe(first.trackerPath);
    expect([spec._content, tracker._content]).toEqual(before);
    expect((app.vault.getAbstractFileByPath(second.specPath) as TFile)._content).toContain("Revised task");
  });

  it.each(["spec", "tracker"])("avoids a document pair when only the %s path is occupied", async (kind) => {
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
    const occupied = app.vault.seed(`Claude/Builds/Feature — ${kind}.md`, "User-owned document.");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    const run = plugin.research().activeBuildRun()!;
    expect(run.specPath).toBe("Claude/Builds/Feature 2 — spec.md");
    expect(run.trackerPath).toBe("Claude/Builds/Feature 2 — tracker.md");
    expect(occupied._content).toBe("User-owned document.");
  });

  it("reserves separate document pairs while another build is being created", async () => {
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
    const create = app.vault.create.bind(app.vault);
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(app.vault, "create").mockImplementationOnce(async (path, body) => {
      await new Promise<void>((resolve) => { release = resolve; started(); });
      return create(path, body);
    });
    const first = acceptBuild(plugin.research().handoffToBuild(plan));
    await pending;
    try { await acceptBuild(plugin.research().handoffToBuild(plan)); }
    finally { release(); await first; }
    const runs = (plugin as unknown as { _build: { serializeState(): { buildRuns: BuildRun[] } } })._build.serializeState().buildRuns;
    expect(runs).toHaveLength(2);
    expect(new Set(runs.flatMap((run) => [run.specPath, run.trackerPath])).size).toBe(4);
  });

  it("keeps persisted run paths reserved when their documents are absent from the vault lookup", async () => {
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    const first = structuredClone(plugin.research().activeBuildRun()!);
    const build = (plugin as unknown as { _build: { restoreState(runs: unknown, active: unknown): void } })._build;
    build.restoreState([first], first.id);
    const lookup = app.vault.getAbstractFileByPath.bind(app.vault);
    vi.spyOn(app.vault, "getAbstractFileByPath").mockImplementation((path) => path === first.specPath || path === first.trackerPath ? null : lookup(path));
    await acceptBuild(plugin.research().handoffToBuild(plan));
    expect(plugin.research().activeBuildRun()!.specPath).not.toBe(first.specPath);
    expect(plugin.research().activeBuildRun()!.trackerPath).not.toBe(first.trackerPath);
  });

  it("never replaces a file created after path selection and allows another attempt", async () => {
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
    const create = app.vault.create.bind(app.vault);
    vi.spyOn(app.vault, "create").mockImplementationOnce(async (path, body) => {
      app.vault.seed(path, "Arrived while creating the build.");
      return create(path, body);
    });
    await acceptBuild(plugin.research().handoffToBuild(plan));
    expect(plugin.research().activeBuildRun()).toBeNull();
    expect((app.vault.getAbstractFileByPath("Claude/Builds/Feature — spec.md") as TFile)._content).toBe("Arrived while creating the build.");
    expect(getNoticeMessages().join("\n")).toContain("Couldn't create build");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    expect(plugin.research().activeBuildRun()!.specPath).toBe("Claude/Builds/Feature 2 — spec.md");
  });

  it("keeps the previous active run when saving a new run fails", async () => {
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    const first = plugin.research().activeBuildRun()!;
    vi.mocked(plugin.persist).mockRejectedValueOnce(new Error("storage unavailable"));
    await acceptBuild(plugin.research().handoffToBuild(plan));
    expect(plugin.research().activeBuildRun()?.id).toBe(first.id);
    const runs = (plugin as unknown as { _build: { serializeState(): { buildRuns: BuildRun[] } } })._build.serializeState().buildRuns;
    expect(runs.map(({ id }) => id)).toEqual([first.id]);
    expect(getNoticeMessages().join("\n")).toContain("storage unavailable");
    expect(getNoticeMessages().join("\n")).toContain("Saved documents:");
  });

  it("creates spec and tracker documents plus a Ready desktop run without touching the clipboard", async () => {
    const { app, plugin, activateBuildView } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "# Feature\n\n- [ ] Parser\n- [ ] UI");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText } });

    const pending = plugin.research().handoffToBuild(plan);
    await acceptBuild(pending);

    const run = plugin.research().activeBuildRun();
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
    await acceptBuild(plugin.research().handoffToBuild(plan));
    expect(plugin.research().activeBuildRun()).toMatchObject({ transport: "cloud", status: "ready" });
  });

  it("starts and completes a mobile task through the real coordinator and cloud executor wiring", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { app, plugin } = pluginHarness();
    Object.assign(plugin.settings, {
      cloudDispatchEnabled: true,
      cloudRoutineFireUrl: "https://api.anthropic.com/v1/claude_code/routines/r1/fire",
      cloudRoutineToken: "routine-token",
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
    Object.assign(plugin.publishing() as unknown as Record<string, unknown>, {
      _cloud: {
        dispatchConfig: () => ({
          fireUrl: plugin.settings.cloudRoutineFireUrl,
          token: plugin.settings.cloudRoutineToken,
          betaHeader: CLOUD_ROUTINE_BETA_HEADER,
        }),
        repliesConfig: () => ({
          repo: plugin.settings.cloudReplyRepo,
          branch: plugin.settings.cloudReplyBranch,
          folder: plugin.settings.cloudReplyFolder,
          token: plugin.settings.cloudReplyToken,
        }),
        httpRequest: request,
      },
    });
    await acceptBuild(plugin.research().handoffToBuild(app.vault.seed("Plans/Cloud.md", "- [ ] Cloud task")));

    const build = (plugin as unknown as { _build: { viewDependencies(): { start(): Promise<void> } } })._build;
    await build.viewDependencies().start();

    expect(plugin.research().activeBuildRun()).toMatchObject({ status: "completed", sessionUrl: "https://claude.ai/code/s1" });
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
    expect(plugin.research().activeBuildRun()).toMatchObject({ status: "interrupted", activeTaskIndex: null });
    expect(plugin.research().activeBuildRun()?.tasks[0]?.status).toBe("pending");
  });
});

describe.each([
  ["America/New_York", "2026-10-18T00:30:00Z", "2026-10-19T00:30:00Z", "2026-10-17"],
  ["Pacific/Auckland", "2026-10-17T12:30:00Z", "2026-10-18T12:30:00Z", "2026-10-18"],
  ["UTC", "2026-10-17T20:30:00Z", "2026-10-18T20:30:00Z", "2026-10-17"],
])("build document dates in %s", (timezone, createdAt, updatedAt, expected) => {
  it("uses the local creation day for both documents and preserves it on later tracker writes", async () => {
    process.env.TZ = timezone;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(createdAt));
    const { app, plugin } = pluginHarness();
    const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
    await acceptBuild(plugin.research().handoffToBuild(plan));
    const run = plugin.research().activeBuildRun()!;
    const spec = app.vault.getAbstractFileByPath(run.specPath) as TFile;
    const tracker = app.vault.getAbstractFileByPath(run.trackerPath) as TFile;
    expect(spec._content).toContain(`created: "${expected}"`);
    expect(tracker._content).toContain(`created: "${expected}"`);
    vi.setSystemTime(new Date(updatedAt));
    const build = (plugin as unknown as { _build: { persistBuildRun(run: BuildRun): Promise<void> } })._build;
    await build.persistBuildRun({ ...run, status: "paused", updatedAt: Date.now() });
    expect(tracker._content).toContain(`created: "${expected}"`);
    expect(tracker._content).toContain("**Status:** Paused");
    expect(plugin.research().activeBuildRun()?.createdAt).toBe(new Date(createdAt).getTime());
  });
});

it("keeps one local creation day when document writes cross midnight", async () => {
  process.env.TZ = "America/New_York";
  vi.useFakeTimers({ toFake: ["Date"] });
  const createdAt = new Date("2026-10-18T03:59:00Z").getTime();
  vi.setSystemTime(createdAt);
  const { app, plugin } = pluginHarness();
  const plan = app.vault.seed("Plans/Feature.md", "- [ ] Task");
  const create = app.vault.create.bind(app.vault);
  vi.spyOn(app.vault, "create").mockImplementationOnce(async (path, content) => {
    vi.setSystemTime(new Date("2026-10-18T04:01:00Z"));
    return create(path, content);
  });
  await acceptBuild(plugin.research().handoffToBuild(plan));
  const run = plugin.research().activeBuildRun()!;
  expect(run.createdAt).toBe(createdAt);
  const build = (plugin as unknown as { _build: { persistBuildRun(run: BuildRun): Promise<void> } })._build;
  await build.persistBuildRun(run);
  for (const path of [run.specPath, run.trackerPath]) expect((app.vault.getAbstractFileByPath(path) as TFile)._content).toContain('created: "2026-10-17"');
});
