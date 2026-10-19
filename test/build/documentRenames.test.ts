import { describe, expect, it, vi } from "vitest";
import { BuildController, type BuildControllerDeps } from "../../src/build/controller";
import { createBuildRun } from "../../src/build/run";
import type { ManagedProcessOptions } from "../../src/build/desktopExecutor";
import { DEFAULT_SETTINGS } from "../../src/types";

function harness(done = false) {
  const run = createBuildRun({ id: "build", title: "Project", specPath: "Builds/spec.md", trackerPath: "Builds/tracker.md", transport: "desktop", tasks: [{ title: "First", done }, { title: "Second", done }], now: 1 });
  const files = new Map([[run.specPath, "spec"], [run.trackerPath, "tracker"]]);
  const pending: { args: string[]; options: ManagedProcessOptions; finish(): void }[] = [];
  const notices: string[] = [];
  let saved: ReturnType<BuildController["serializeState"]>;
  let writeError: string | null = null;
  const deps: BuildControllerDeps = {
    settings: () => structuredClone(DEFAULT_SETTINGS), persist: async () => { saved = structuredClone(controller.serializeState()); }, isMobile: false,
    vault: {
      cachedRead: async (path) => files.get(path)!,
      processFile: async (path, fn) => { if (writeError || !files.has(path)) throw new Error(writeError ?? `File not found: ${path}`); files.set(path, fn(files.get(path)!)); },
    },
    writeFile: async (path, text) => { files.set(path, text); }, ensureFolder: async () => {}, normalizePath: (path) => path,
    openFile: async (path) => { opened.push(path); }, notice: (message) => { notices.push(message); }, confirm: async () => true,
    cloud: () => { throw new Error("not a cloud test"); }, vaultBasePath: () => "/vault", desktopProcess: () => ({ platform: "darwin", env: { HOME: "/user" } }),
    desktopRuntimeLoader: async () => ({
      createNodeDesktopRuntime: async () => ({ resolveClaudeCodeExecutable: async () => "claude" }),
      createNodeManagedProcessPort: () => ({ run: async (_executable, args, options) => {
        await new Promise<void>((resolve) => pending.push({ args, options, finish: resolve }));
        options.onStdout('{"type":"result","subtype":"success","is_error":false,"result":"Task complete"}\n');
        return { code: 0, stderr: "" };
      } }),
    }),
  };
  const opened: string[] = [];
  const controller = new BuildController(deps);
  controller.restoreState([run], run.id);
  const move = async (oldPath: string, newPath: string) => {
    for (const [path, text] of [...files]) if (path === oldPath || path.startsWith(`${oldPath}/`)) { files.delete(path); files.set(newPath + path.slice(oldPath.length), text); }
    await controller.renameDocuments(oldPath, newPath);
  };
  return { controller, deps, files, opened, pending, notices, move, saved: () => saved!, failWrites: (message: string | null) => { writeError = message; } };
}

describe("build document renames", () => {
  it("resumes a paused build using renamed spec and tracker paths and preserves them after restore", async () => {
    const h = harness();
    const view = h.controller.viewDependencies();
    const first = view.start();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await view.pause();
    h.pending[0]!.finish();
    await first;
    await h.move("Builds/spec.md", "Builds/renamed-spec.md");
    await h.move("Builds/tracker.md", "Builds/renamed-tracker.md");
    const resumed = view.resume();
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    expect(h.pending[1]!.args.join(" ")).toContain("Builds/renamed-spec.md");
    h.pending[1]!.finish();
    await resumed;
    expect(h.files.get("Builds/renamed-tracker.md")).toContain("**Status:** Complete");
    expect(h.files.has("Builds/tracker.md")).toBe(false);
    h.controller.restoreState(h.saved().buildRuns, h.saved().activeBuildRunId);
    await view.openSpec();
    await view.openTracker();
    expect(h.opened).toEqual(["Builds/renamed-spec.md", "Builds/renamed-tracker.md"]);
  });

  it("follows a folder move while a task is running without reviving stale paths on later output", async () => {
    const h = harness();
    const view = h.controller.viewDependencies();
    const executing = view.start();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await h.move("Builds", "Projects/Builds");
    h.pending[0]!.options.onStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"first task progress"}]}}\n');
    h.pending[0]!.finish();
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    expect(h.pending[1]!.args.join(" ")).toContain("Projects/Builds/spec.md");
    h.pending[1]!.finish();
    await executing;
    expect(h.controller.activeBuildRun()).toMatchObject({ specPath: "Projects/Builds/spec.md", trackerPath: "Projects/Builds/tracker.md", status: "completed" });
    expect(h.files.get("Projects/Builds/tracker.md")).toContain("**Progress:** 2 / 2");
    await h.controller.renameDocuments("Projects/Build", "Wrong");
    expect(h.controller.activeBuildRun()?.trackerPath).toBe("Projects/Builds/tracker.md");
  });

  it("resolves the renamed tracker when a progress save was already pending", async () => {
    const h = harness(true);
    const persist = h.deps.persist;
    let release!: () => void;
    let pending = false;
    h.deps.persist = async () => {
      if (!pending) { pending = true; await new Promise<void>((resolve) => { release = resolve; }); }
      await persist();
    };
    const executing = h.controller.viewDependencies().start();
    await vi.waitFor(() => expect(pending).toBe(true));
    await h.move("Builds/tracker.md", "Builds/latest.md");
    release();
    await executing;
    expect(h.files.get("Builds/latest.md")).toContain("**Status:** Complete");
    expect(h.files.has("Builds/tracker.md")).toBe(false);
    expect(h.notices).toEqual([]);
  });

  it("keeps the live renamed path and reports a failure to save its reference", async () => {
    const h = harness();
    h.deps.persist = async () => { throw new Error("disk full"); };
    await h.move("Builds/tracker.md", "Builds/latest.md");
    expect(h.controller.activeBuildRun()?.trackerPath).toBe("Builds/latest.md");
    expect(h.notices.join(" ")).toContain("disk full");
  });

  it.each(["missing", "permission denied"])("retains completed tasks and retries only tracker synchronization after %s", async (failure) => {
    const h = harness(true);
    if (failure === "missing") h.files.delete("Builds/tracker.md");
    else h.failWrites(failure);
    const view = h.controller.viewDependencies();
    await view.start();
    expect(h.controller.activeBuildRun()).toMatchObject({ status: "completed", trackerError: expect.stringContaining("tracker") });
    expect(h.notices).toHaveLength(1);
    h.controller.restoreState(h.saved().buildRuns, h.saved().activeBuildRunId);
    expect(h.controller.activeBuildRun()?.trackerError).toContain("tracker");
    h.failWrites(null);
    h.files.set("Builds/tracker.md", "restored");
    await view.retryTracker();
    expect(h.controller.activeBuildRun()?.trackerError).toBeUndefined();
    expect(h.files.get("Builds/tracker.md")).toContain("**Status:** Complete");
    expect(h.controller.activeBuildRun()?.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(h.pending).toHaveLength(0);
  });
});
