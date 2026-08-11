import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf, type FakeElement } from "obsidian";
import { BuildView, type BuildViewDependencies } from "../../src/view/BuildView";
import { createBuildRun, type BuildRun } from "../../src/build/run";

const makeRun = (status: BuildRun["status"] = "ready", transport: BuildRun["transport"] = "desktop"): BuildRun => ({
  ...createBuildRun({
    id: "run-1", title: "Comment threads", specPath: "Builds/spec.md", trackerPath: "Builds/tracker.md", transport,
    tasks: [{ title: "Parser", done: false }, { title: "UI", done: false }], now: 1,
  }),
  status,
});

function harness(initial = makeRun()) {
  let run = initial;
  let listener: ((snapshot: BuildRun) => void) | undefined;
  const actions = { start: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), openSpec: vi.fn(), openTracker: vi.fn(), openSession: vi.fn() };
  const deps: BuildViewDependencies = {
    getRun: () => run,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
    ...actions,
  };
  const view = new BuildView(new WorkspaceLeaf(), deps);
  const update = (next: BuildRun) => { run = next; listener?.(next); };
  return { view, actions, update };
}

const rootOf = (view: BuildView): FakeElement => view.contentEl as unknown as FakeElement;

describe("BuildView", () => {
  it("renders accessible Ready state and starts without exposing a command", async () => {
    const h = harness();
    await h.view.onOpen();
    const root = rootOf(h.view);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Ready");
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
    const start = root.querySelector(".cc-build-start")!;
    expect(start.textContent).toBe("Start build");
    expect(start.getAttribute("aria-label")).toBe("Start build");
    start.dispatchEvent({ type: "click" });
    expect(h.actions.start).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain("copy");
    expect(root.textContent).not.toContain("terminal");
  });

  it("shows truthful controls and progress across running, paused, failed, and completed states", async () => {
    const h = harness();
    await h.view.onOpen();
    const root = rootOf(h.view);
    const running = { ...makeRun("running"), activeTaskIndex: 0 };
    running.tasks[0]!.status = "running";
    h.update(running);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Running task 1 of 2");
    expect(root.querySelector(".cc-build-pause")?.textContent).toBe("Pause after current task");

    const paused = { ...running, status: "paused" as const, activeTaskIndex: null };
    paused.tasks[0]!.status = "completed";
    h.update(paused);
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
    expect(root.querySelector(".cc-build-start")?.textContent).toBe("Resume build");

    h.update({ ...paused, status: "failed", error: "Claude Code authentication failed" });
    expect(root.querySelector(".cc-build-error")?.textContent).toContain("authentication failed");
    expect(root.querySelector(".cc-build-start")?.textContent).toBe("Retry task");

    h.update({ ...paused, status: "completed", tasks: paused.tasks.map((task) => ({ ...task, status: "completed" })) });
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Build complete");
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
  });

  it("explains mobile task-boundary pause and cancellation", async () => {
    const h = harness(makeRun("running", "cloud"));
    await h.view.onOpen();
    const disclosure = rootOf(h.view).querySelector(".cc-build-cloud-boundary");
    expect(disclosure?.textContent).toContain("current cloud task may finish");
    expect(rootOf(h.view).querySelector(".cc-build-cancel")?.textContent).toBe("Cancel after current task");
  });

  it("patches stable DOM nodes through rapid updates without inline CSS or style injection", async () => {
    const h = harness();
    await h.view.onOpen();
    const root = rootOf(h.view);
    const progress = root.querySelector('[role="progressbar"]');
    const status = root.querySelector('[role="status"]');
    for (let index = 0; index < 20; index += 1) {
      h.update({ ...makeRun(index % 2 === 0 ? "running" : "pause_requested"), log: `event ${index}`, updatedAt: index + 2 });
    }
    expect(root.querySelector('[role="progressbar"]')).toBe(progress);
    expect(root.querySelector('[role="status"]')).toBe(status);
    expect(root.querySelectorAll("style")).toHaveLength(0);
    expect(root.querySelectorAll("div").every((element) => Object.keys(element.style).length === 0)).toBe(true);
  });
});
