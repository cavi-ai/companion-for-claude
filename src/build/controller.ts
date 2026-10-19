import type { PluginSettings } from "../types";
import type { BuildViewDependencies } from "../view/BuildView";
import { BuildRunCoordinator, createBuildRun, restoreBuildRuns, type BuildRun, type BuildTaskExecutor } from "./run";
import { extractTasks, specBody, type SpecInput } from "./spec";
import { trackerNoteBody } from "./tracker";
import { DesktopBuildExecutor, type ManagedProcessPort } from "./desktopExecutor";
import { CloudBuildExecutor, type CloudBuildHttpRequest } from "./cloudExecutor";
import { configError, type CloudDispatchConfig } from "../cloud/routines";
import { configError as repliesConfigError, type RepliesConfig } from "../cloud/replies";
import { buildFrontmatter, localCalendarDate, normalizeTags } from "../indexing/frontmatter";

type DesktopExecutorPlatform = "darwin" | "win32" | "linux" | "unsupported";

interface DesktopRuntimeModule {
  createNodeDesktopRuntime(
    platform: DesktopExecutorPlatform,
    homeDir: string,
    env: Record<string, string | undefined>,
  ): Promise<{ resolveClaudeCodeExecutable?: () => Promise<string> }>;
  createNodeManagedProcessPort(): ManagedProcessPort;
}

export interface BuildControllerDeps {
  settings: () => PluginSettings;
  persist: () => Promise<void>;
  isMobile: boolean;

  vault: {
    exists: (path: string) => boolean;
    cachedRead: (path: string) => Promise<string>;
    processFile: (path: string, fn: (data: string) => string) => Promise<void>;
  };
  createFile: (path: string, content: string) => Promise<void>;
  ensureFolder: (folder: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  normalizePath: (path: string) => string;

  notice: (msg: string, timeout?: number) => void;
  confirm: (opts: { title: string; body: string; cta: string }) => Promise<boolean>;

  cloud: () => {
    dispatchConfig(): CloudDispatchConfig;
    repliesConfig(): RepliesConfig;
    httpRequest(request: CloudBuildHttpRequest): Promise<{ status: number; text: string }>;
  };
  vaultBasePath: () => string | null;
  desktopProcess: () => { platform?: string; env?: Record<string, string | undefined> } | undefined;
  desktopRuntimeLoader: () => Promise<DesktopRuntimeModule>;
}

export class BuildController {
  private buildRuns: Record<string, BuildRun> = {};
  private activeBuildRunId: string | null = null;
  private buildCoordinators = new Map<string, BuildRunCoordinator>();
  private buildRunListeners = new Set<(run: BuildRun) => void>();
  private buildTrackerWriteChains = new Map<string, Promise<void>>();
  private pendingDocumentPaths = new Set<string>();

  constructor(private readonly deps: BuildControllerDeps) {}

  destroy(): void {
    for (const coordinator of this.buildCoordinators.values()) void coordinator.dispose();
    this.buildCoordinators.clear();
    this.buildRunListeners.clear();
  }

  restoreState(rawRuns: unknown, rawActiveId: unknown): void {
    const runs = restoreBuildRuns(rawRuns);
    this.buildRuns = Object.fromEntries(runs.map((run) => [run.id, run]));
    this.activeBuildRunId =
      typeof rawActiveId === "string" && this.buildRuns[rawActiveId]
        ? rawActiveId
        : runs.at(-1)?.id ?? null;
  }

  serializeState(): { buildRuns: BuildRun[]; activeBuildRunId: string | null } {
    return {
      buildRuns: Object.values(this.buildRuns),
      activeBuildRunId: this.activeBuildRunId,
    };
  }

  activeBuildRun(): BuildRun | null {
    if (!this.activeBuildRunId) return null;
    return this.buildRuns[this.activeBuildRunId] ?? null;
  }

  async selectActiveRun(runId: string): Promise<void> {
    if (!this.buildRuns[runId] || this.activeBuildRunId === runId) return;
    const previous = this.activeBuildRunId;
    this.activeBuildRunId = runId;
    this.notifySelectedRun();
    try {
      await this.deps.persist();
    } catch (cause) {
      if (this.activeBuildRunId === runId) {
        this.activeBuildRunId = previous;
        this.notifySelectedRun();
      }
      this.deps.notice(`Couldn't save the selected build: ${cause instanceof Error ? cause.message : String(cause)}`, 8000);
    }
  }

  private notifySelectedRun(): void {
    const run = this.activeBuildRun();
    if (run) for (const listener of this.buildRunListeners) listener(run);
  }

  async renameDocuments(oldPath: string, newPath: string): Promise<void> {
    const renamed = (path: string): string => path === oldPath || path.startsWith(`${oldPath}/`)
      ? newPath + path.slice(oldPath.length) : path;
    let changed = false;
    for (const run of Object.values(this.buildRuns)) {
      const paths = { specPath: renamed(run.specPath), trackerPath: renamed(run.trackerPath) };
      if (paths.specPath === run.specPath && paths.trackerPath === run.trackerPath) continue;
      Object.assign(run, paths);
      this.buildCoordinators.get(run.id)?.updateDocumentPaths(paths);
      changed = true;
    }
    if (!changed) return;
    this.notifySelectedRun();
    try {
      await this.deps.persist();
    } catch (cause) {
      this.deps.notice(`Couldn't save renamed build document paths: ${cause instanceof Error ? cause.message : String(cause)}`, 8000);
    }
  }

  async handoffToBuild(planFile: { path: string; basename: string } | null): Promise<string | null> {
    if (!planFile) {
      this.deps.notice(
        "Open a plan note first — a note with a task checklist (`- [ ]`) or numbered milestones.",
        8000,
      );
      return null;
    }
    const plan = await this.deps.vault.cachedRead(planFile.path);
    const tasks = extractTasks(plan);
    if (tasks.length === 0) {
      this.deps.notice(
        `"${planFile.basename}" doesn't look like a plan — no task checklist (\`- [ ]\`) or numbered milestones found. ` +
          `Run "Generate implementation plan" first, or add tasks, then build.`,
        9000,
      );
      return null;
    }

    const title = planFile.basename;
    const folder = "Claude/Builds";

    const confirmed = await this.deps.confirm({
      title: "Build from this plan?",
      body:
        `Detected ${tasks.length} task${tasks.length === 1 ? "" : "s"} in "${planFile.basename}".\n\n` +
        `This creates a build spec and tracker in "${folder}", then opens Build Runner. Nothing runs until you press Start.`,
      cta: "Create build",
    });
    if (!confirmed) return null;

    const { specPath, trackerPath } = this.reserveDocumentPaths(folder, title);
    const created: string[] = [];
    let newRunId: string | null = null;
    let previousActiveId: string | null = null;
    try {
      await this.deps.ensureFolder(folder);

      const input: SpecInput = { title, plan, specPath, trackerPath, tasks };
      const createdAt = Date.now();
      const now = localCalendarDate(new Date(createdAt));

      const specFm = buildFrontmatter({
        title: `${title} — spec`,
        created: now,
        source: "claude-companion",
        type: "build-spec",
        tags: normalizeTags(["claude", "build", "spec"]),
      });
      await this.deps.createFile(specPath, `${specFm}\n\n${specBody(input)}`);
      created.push(specPath);

      const run = createBuildRun({
        id: `build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        specPath,
        trackerPath,
        transport: this.deps.isMobile ? "cloud" : "desktop",
        tasks,
        now: createdAt,
      });

      const trackerFm = buildFrontmatter({
        title: `${title} — tracker`,
        created: now,
        source: "claude-companion",
        type: "build-tracker",
        tags: normalizeTags(["claude", "build", "tracker"]),
      });
      await this.deps.createFile(trackerPath, `${trackerFm}\n\n${trackerNoteBody(run)}`);
      created.push(trackerPath);
      previousActiveId = this.activeBuildRunId;
      newRunId = run.id;
      this.buildRuns[run.id] = run;
      this.activeBuildRunId = run.id;
      await this.deps.persist();
      return run.id;
    } catch (error) {
      if (newRunId) {
        delete this.buildRuns[newRunId];
        if (this.activeBuildRunId === newRunId) this.activeBuildRunId = previousActiveId;
      }
      this.deps.notice(`Couldn't create build: ${error instanceof Error ? error.message : String(error)}${created.length > 0 ? `\nSaved documents: ${created.join(", ")}` : ""}`, 10000);
      return null;
    } finally {
      this.pendingDocumentPaths.delete(specPath);
      this.pendingDocumentPaths.delete(trackerPath);
    }
  }

  private reserveDocumentPaths(folder: string, title: string): { specPath: string; trackerPath: string } {
    const owned = new Set(Object.values(this.buildRuns).flatMap((run) => [run.specPath, run.trackerPath]));
    for (let suffix = 1; ; suffix++) {
      const name = suffix === 1 ? title : `${title} ${suffix}`;
      const specPath = this.deps.normalizePath(`${folder}/${name} — spec.md`);
      const trackerPath = this.deps.normalizePath(`${folder}/${name} — tracker.md`);
      if ([specPath, trackerPath].some((path) => owned.has(path) || this.pendingDocumentPaths.has(path) || this.deps.vault.exists(path))) continue;
      this.pendingDocumentPaths.add(specPath);
      this.pendingDocumentPaths.add(trackerPath);
      return { specPath, trackerPath };
    }
  }

  viewDependencies(): BuildViewDependencies {
    return {
      getRun: () => this.activeBuildRun(),
      getRuns: () => Object.values(this.buildRuns),
      selectRun: (runId) => this.selectActiveRun(runId),
      subscribe: (listener) => {
        this.buildRunListeners.add(listener);
        return () => this.buildRunListeners.delete(listener);
      },
      start: () => this.runActiveBuild("start"),
      pause: () => this.runActiveBuild("pause"),
      resume: () => this.runActiveBuild("resume"),
      cancel: () => this.runActiveBuild("cancel"),
      openSpec: () => this.openActiveBuildFile("specPath"),
      openTracker: () => this.openActiveBuildFile("trackerPath"),
      retryTracker: async () => {
        const run = this.activeBuildRun();
        if (run) {
          await this.persistBuildRun(run);
          this.notifySelectedRun();
        }
      },
      openSession: () => {
        const url = this.activeBuildRun()?.sessionUrl;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      },
    };
  }

  private async openActiveBuildFile(field: "specPath" | "trackerPath"): Promise<void> {
    const path = this.activeBuildRun()?.[field];
    if (path) {
      try { await this.deps.openFile(path); }
      catch (cause) { this.deps.notice(`Couldn't open build document: ${cause instanceof Error ? cause.message : String(cause)}`, 8000); }
    }
  }

  private runActiveBuild(action: "start" | "pause" | "resume" | "cancel"): Promise<void> {
    const run = this.activeBuildRun();
    if (!run) return Promise.resolve();
    return this.buildCoordinatorFor(run)[action]();
  }

  private buildCoordinatorFor(run: BuildRun): BuildRunCoordinator {
    const existing = this.buildCoordinators.get(run.id);
    if (existing) return existing;
    const coordinator = new BuildRunCoordinator(run, {
      executor: this.buildExecutor(run.transport),
      persist: (snapshot) => this.persistBuildRun(snapshot),
      onChange: () => this.notifySelectedRun(),
    });
    this.buildCoordinators.set(run.id, coordinator);
    return coordinator;
  }

  private buildExecutor(transport: BuildRun["transport"]): BuildTaskExecutor {
    if (transport === "cloud") {
      let executor: CloudBuildExecutor | null = null;
      return {
        cancelMode: "after-current",
        execute: async (input, signal, emit) => {
          if (!this.deps.settings().cloudDispatchEnabled)
            throw new Error("Cloud builds are off. Open Companion settings → Cloud session, enable dispatch, then Retry.");
          const cloud = this.deps.cloud();
          const routineError = configError(cloud.dispatchConfig());
          if (routineError) throw new Error(`Cloud build setup is incomplete: ${routineError}`);
          const replyError = repliesConfigError(cloud.repliesConfig());
          if (replyError) throw new Error(`Cloud build tracking is incomplete: ${replyError}`);
          executor ??= new CloudBuildExecutor({
            routine: cloud.dispatchConfig(),
            replies: cloud.repliesConfig(),
            http: { request: (request: CloudBuildHttpRequest) => cloud.httpRequest(request) },
          });
          return executor.execute(input, signal, emit);
        },
      };
    }

    let executor: DesktopBuildExecutor | null = null;
    return {
      cancelMode: "immediate",
      execute: async (input, signal, emit) => {
        if (!executor) {
          const vaultPath = this.deps.vaultBasePath();
          if (!vaultPath) throw new Error("This vault does not expose a desktop filesystem path. Move it to a local filesystem vault, then Retry.");
          const processLike = this.deps.desktopProcess();
          const platform: DesktopExecutorPlatform =
            processLike?.platform === "darwin" || processLike?.platform === "win32" || processLike?.platform === "linux"
              ? processLike.platform
              : "unsupported";
          const env = processLike?.env ?? {};
          const homeDir = env.HOME || env.USERPROFILE || "";
          if (!homeDir) throw new Error("The desktop home directory is unavailable. Open Desktop integrations for setup help.");
          const mod = await this.deps.desktopRuntimeLoader();
          const runtime = await mod.createNodeDesktopRuntime(platform, homeDir, { APPDATA: env.APPDATA });
          if (!runtime.resolveClaudeCodeExecutable) throw new Error("This Companion build cannot manage Claude Code. Update Companion, then Retry.");
          const executable = await runtime.resolveClaudeCodeExecutable();
          executor = new DesktopBuildExecutor({ process: mod.createNodeManagedProcessPort(), executable, cwd: vaultPath });
        }
        return executor.execute(input, signal, emit);
      },
    };
  }

  private async persistBuildRun(run: BuildRun): Promise<void> {
    const current = this.buildRuns[run.id];
    run = { ...run, specPath: current?.specPath ?? run.specPath, trackerPath: current?.trackerPath ?? run.trackerPath };
    if (current?.trackerError) run.trackerError = current.trackerError;
    else delete run.trackerError;
    this.buildRuns[run.id] = run;
    await this.deps.persist();
    const previous = this.buildTrackerWriteChains.get(run.id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const paths = this.buildRuns[run.id]!;
      const trackerFm = buildFrontmatter({
        title: `${run.title} — tracker`,
        created: localCalendarDate(new Date(run.createdAt)),
        source: "claude-companion",
        type: "build-tracker",
        tags: normalizeTags(["claude", "build", "tracker"]),
      });
      let trackerError: string | undefined;
      try {
        await this.deps.vault.processFile(paths.trackerPath, () => `${trackerFm}\n\n${trackerNoteBody(run)}`);
      } catch (cause) {
        trackerError = `Couldn't update build tracker "${paths.trackerPath}": ${cause instanceof Error ? cause.message : String(cause)}. Restore the note or fix access, then retry the tracker update.`;
      }
      const latest = this.buildRuns[run.id]!;
      if (latest.trackerError !== trackerError) {
        if (trackerError) latest.trackerError = trackerError;
        else delete latest.trackerError;
        if (trackerError) this.deps.notice(trackerError, 10000);
        await this.deps.persist();
      }
    });
    this.buildTrackerWriteChains.set(run.id, write);
    await write;
    if (this.buildTrackerWriteChains.get(run.id) === write) this.buildTrackerWriteChains.delete(run.id);
  }
}
