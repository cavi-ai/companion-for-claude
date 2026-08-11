import { describe, expect, it, vi } from "vitest";
import {
  BuildRunCoordinator,
  buildProgress,
  createBuildRun,
  type BuildTaskExecution,
  type BuildTaskExecutor,
} from "../../src/build/run";

class Deferred<T> {
  promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function harness(cancelMode: "immediate" | "after-current" = "immediate") {
  const pending: Deferred<BuildTaskExecution>[] = [];
  const calls: Array<{ index: number; signal: AbortSignal; emit: (line: string) => void }> = [];
  const executor: BuildTaskExecutor = {
    cancelMode,
    execute(input, signal, emit) {
      const deferred = new Deferred<BuildTaskExecution>();
      pending.push(deferred);
      calls.push({ index: input.index, signal, emit });
      return deferred.promise;
    },
  };
  const persisted: string[] = [];
  const observed: string[] = [];
  const run = createBuildRun({
    id: "run-1",
    title: "Ship it",
    specPath: "Builds/spec.md",
    trackerPath: "Builds/tracker.md",
    transport: cancelMode === "immediate" ? "desktop" : "cloud",
    tasks: [{ title: "First", done: false }, { title: "Second", done: false }],
    now: 10,
  });
  const coordinator = new BuildRunCoordinator(run, {
    executor,
    persist: async (snapshot) => { persisted.push(`${snapshot.status}:${snapshot.activeTaskIndex}`); },
    onChange: (snapshot) => { observed.push(snapshot.status); },
    now: () => 20 + persisted.length,
    maxLogChars: 24,
  });
  return { coordinator, pending, calls, persisted, observed };
}

describe("BuildRunCoordinator", () => {
  it("runs tasks sequentially and ignores duplicate Start clicks", async () => {
    const h = harness();
    const firstStart = h.coordinator.start();
    const duplicateStart = h.coordinator.start();
    expect(firstStart).toBe(duplicateStart);
    await vi.waitFor(() => expect(h.calls.map((call) => call.index)).toEqual([0]));

    h.pending[0]!.resolve({ summary: "first done" });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls.map((call) => call.index)).toEqual([0, 1]);
    h.pending[1]!.resolve({ summary: "second done" });
    await firstStart;

    expect(h.coordinator.snapshot().status).toBe("completed");
    expect(h.coordinator.snapshot().tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    expect(buildProgress(h.coordinator.snapshot())).toEqual({ completed: 2, total: 2, percent: 100 });
    expect(h.persisted.at(-1)).toBe("completed:null");
  });

  it("pauses after the active task and resumes at the next one", async () => {
    const h = harness();
    const firstRun = h.coordinator.start();
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await h.coordinator.pause();
    expect(h.coordinator.snapshot().status).toBe("pause_requested");
    expect(h.calls[0]!.signal.aborted).toBe(false);

    h.pending[0]!.resolve({});
    await firstRun;
    expect(h.coordinator.snapshot().status).toBe("paused");
    expect(h.calls).toHaveLength(1);

    const resumed = h.coordinator.resume();
    await vi.waitFor(() => expect(h.calls.map((call) => call.index)).toEqual([0, 1]));
    h.pending[1]!.resolve({});
    await resumed;
    expect(h.coordinator.snapshot().status).toBe("completed");
  });

  it("cancels an active desktop process immediately", async () => {
    const h = harness("immediate");
    const running = h.coordinator.start();
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await h.coordinator.cancel();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    h.pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await running;
    expect(h.coordinator.snapshot().status).toBe("cancelled");
    expect(h.coordinator.snapshot().tasks[0]!.status).toBe("pending");
  });

  it("cancels a cloud build after its active task without firing the next task", async () => {
    const h = harness("after-current");
    const running = h.coordinator.start();
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await h.coordinator.cancel();
    expect(h.coordinator.snapshot().status).toBe("cancel_requested");
    expect(h.calls[0]!.signal.aborted).toBe(false);
    h.pending[0]!.resolve({ sessionUrl: "https://claude.ai/code/session-1" });
    await running;
    expect(h.coordinator.snapshot().status).toBe("cancelled");
    expect(h.calls).toHaveLength(1);
    expect(h.coordinator.snapshot().sessionUrl).toBe("https://claude.ai/code/session-1");
  });

  it("keeps bounded output and exposes a failed task for retry", async () => {
    const h = harness();
    const running = h.coordinator.start();
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.calls[0]!.emit("1234567890");
    h.calls[0]!.emit("abcdefghij");
    h.calls[0]!.emit("KLMNOPQRST");
    h.pending[0]!.reject(new Error("Claude Code is not authenticated"));
    await running;

    const failed = h.coordinator.snapshot();
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Claude Code is not authenticated");
    expect(failed.log.length).toBeLessThanOrEqual(24);
    expect(failed.log).not.toContain("123456");

    const retried = h.coordinator.resume();
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls.map((call) => call.index)).toEqual([0, 0]);
    h.pending[1]!.resolve({});
    await vi.waitFor(() => expect(h.calls).toHaveLength(3));
    h.pending[2]!.resolve({});
    await retried;
    expect(h.coordinator.snapshot().status).toBe("completed");
  });

  it("marks an active build interrupted on dispose and ignores late completion", async () => {
    const h = harness();
    const running = h.coordinator.start();
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await h.coordinator.dispose();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.coordinator.snapshot().status).toBe("interrupted");
    h.pending[0]!.resolve({ summary: "too late" });
    await running;
    expect(h.coordinator.snapshot().status).toBe("interrupted");
    expect(h.coordinator.snapshot().tasks[0]!.status).toBe("pending");
  });

  it("persists every visible transition before notifying consumers", async () => {
    const order: string[] = [];
    const executor: BuildTaskExecutor = { cancelMode: "immediate", execute: async () => ({}) };
    const coordinator = new BuildRunCoordinator(createBuildRun({
      id: "empty", title: "Done", specPath: "s", trackerPath: "t", transport: "desktop", tasks: [], now: 1,
    }), {
      executor,
      persist: async (run) => { order.push(`persist:${run.status}`); },
      onChange: (run) => { order.push(`notify:${run.status}`); },
      now: () => 2,
    });
    await coordinator.start();
    expect(order).toEqual(["persist:completed", "notify:completed"]);
  });
});
