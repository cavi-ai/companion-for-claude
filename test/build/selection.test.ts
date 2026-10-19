import { describe, expect, it, vi } from "vitest";
import { BuildController, type BuildControllerDeps } from "../../src/build/controller";
import { createBuildRun, type BuildRun } from "../../src/build/run";
import type { ManagedProcessOptions } from "../../src/build/desktopExecutor";
import { DEFAULT_SETTINGS } from "../../src/types";

function harness() {
  const runs = ["first", "second"].map((id, index) => createBuildRun({ id, title: "Same title", specPath: `${id}-spec.md`, trackerPath: `${id}-tracker.md`, transport: "desktop", tasks: [{ title: id, done: false }], now: index + 1 }));
  const files = new Map(runs.flatMap((run) => [[run.specPath, run.id], [run.trackerPath, ""]]));
  let saved: ReturnType<BuildController["serializeState"]>;
  let processOptions: ManagedProcessOptions | undefined;
  let finish: (() => void) | undefined;
  const process = { run: async (_executable: string, _args: string[], options: ManagedProcessOptions) => {
    processOptions = options;
    await new Promise<void>((resolve) => { finish = resolve; });
    return { code: 0, stderr: "" };
  } };
  const opened: string[] = [];
  const notices: string[] = [];
  const deps: BuildControllerDeps = {
    settings: () => structuredClone(DEFAULT_SETTINGS),
    persist: async () => { saved = structuredClone(controller.serializeState()); },
    isMobile: false,
    vault: { cachedRead: async (path) => files.get(path)!, processFile: async (path, fn) => { files.set(path, fn(files.get(path)!)); } },
    writeFile: async (path, content) => { files.set(path, content); },
    ensureFolder: async () => {}, openFile: async (path) => { opened.push(path); }, normalizePath: (path) => path,
    notice: (message) => { notices.push(message); }, confirm: async () => true,
    cloud: () => { throw new Error("not a cloud test"); },
    vaultBasePath: () => "/vault", desktopProcess: () => ({ platform: "darwin", env: { HOME: "/user" } }),
    desktopRuntimeLoader: async () => ({ createNodeDesktopRuntime: async () => ({ resolveClaudeCodeExecutable: async () => "claude" }), createNodeManagedProcessPort: () => process }),
  };
  const controller = new BuildController(deps);
  controller.restoreState(runs, "second");
  return { controller, deps, opened, files, notices, saved: () => saved!, processOptions: () => processOptions!, finish: () => finish!() };
}

describe("saved build selection", () => {
  it("selects by identity, updates subscribers, persists selection and opens the selected documents", async () => {
    const h = harness();
    const view = h.controller.viewDependencies();
    const selected: string[] = [];
    view.subscribe((run) => selected.push(run.id));
    await h.controller.selectActiveRun("first");
    expect(selected).toEqual(["first"]);
    expect(h.saved().activeBuildRunId).toBe("first");
    await view.openSpec();
    await view.openTracker();
    expect(h.opened).toEqual(["first-spec.md", "first-tracker.md"]);
    h.controller.restoreState(h.saved().buildRuns, h.saved().activeBuildRunId);
    expect(view.getRun()?.id).toBe("first");
    await h.controller.selectActiveRun("missing");
    expect(view.getRun()?.id).toBe("first");
  });

  it("keeps another build selected while a background task emits output and completes", async () => {
    const h = harness();
    const view = h.controller.viewDependencies();
    await h.controller.selectActiveRun("first");
    const pending = view.start();
    await vi.waitFor(() => expect(h.processOptions()).toBeDefined());
    await h.controller.selectActiveRun("second");
    const shown: BuildRun[] = [];
    view.subscribe((run) => shown.push(run));
    h.processOptions().onStdout('{"type":"result","subtype":"success","is_error":false,"result":"First task done"}\n');
    h.finish();
    await pending;
    expect(view.getRun()?.id).toBe("second");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((run) => run.id === "second")).toBe(true);
    expect(h.saved().activeBuildRunId).toBe("second");
    expect(h.saved().buildRuns.find((run) => run.id === "first")?.status).toBe("completed");
    expect(h.files.get("first-tracker.md")).toContain("**Status:** Complete");
    expect(h.files.get("second-tracker.md")).toBe("");
  });

  it("keeps the selected build visible when another build finishes retrying its tracker", async () => {
    const h = harness();
    const view = h.controller.viewDependencies();
    await h.controller.selectActiveRun("first");
    const processFile = h.deps.vault.processFile;
    let release: (() => void) | undefined;
    vi.spyOn(h.deps.vault, "processFile").mockImplementationOnce(async (path, transform) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await processFile(path, transform);
    });
    const pending = view.retryTracker();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await h.controller.selectActiveRun("second");
    const shown: string[] = [];
    view.subscribe((run) => shown.push(run.id));
    release!();
    await pending;
    expect(view.getRun()?.id).toBe("second");
    expect(shown).toEqual(["second"]);
  });

  it("reports a selection save failure and restores the previous selection", async () => {
    const h = harness();
    h.deps.persist = async () => { throw new Error("disk full"); };
    await h.controller.selectActiveRun("first");
    expect(h.controller.activeBuildRun()?.id).toBe("second");
    expect(h.notices.join(" ")).toContain("disk full");
  });
});
