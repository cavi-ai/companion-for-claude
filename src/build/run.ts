import type { BuildTask } from "./spec";

export type BuildTransport = "desktop" | "cloud";
export type BuildRunStatus =
  | "ready"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "completed";
export type BuildTaskStatus = "pending" | "running" | "completed";

export interface BuildTaskRun {
  title: string;
  status: BuildTaskStatus;
  summary?: string;
  sessionId?: string;
  sessionUrl?: string;
}

export interface BuildRun {
  id: string;
  title: string;
  specPath: string;
  trackerPath: string;
  transport: BuildTransport;
  status: BuildRunStatus;
  tasks: BuildTaskRun[];
  activeTaskIndex: number | null;
  log: string;
  error?: string;
  sessionUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBuildRunInput {
  id: string;
  title: string;
  specPath: string;
  trackerPath: string;
  transport: BuildTransport;
  tasks: BuildTask[];
  now: number;
}

export interface BuildTaskExecutionInput {
  runId: string;
  title: string;
  index: number;
  total: number;
  specPath: string;
  trackerPath: string;
  transport: BuildTransport;
  sessionId?: string;
  sessionUrl?: string;
}

export interface BuildTaskExecution {
  summary?: string;
  sessionUrl?: string;
}

export interface BuildTaskExecutor {
  cancelMode: "immediate" | "after-current";
  execute(
    input: BuildTaskExecutionInput,
    signal: AbortSignal,
    emit: (event: BuildTaskEvent) => void,
  ): Promise<BuildTaskExecution>;
}

export type BuildTaskEvent = string | { type: "session"; sessionId?: string; sessionUrl?: string };

export interface BuildRunCoordinatorOptions {
  executor: BuildTaskExecutor;
  persist(run: BuildRun): Promise<void>;
  onChange?(run: BuildRun): void;
  now?: () => number;
  maxLogChars?: number;
}

export function createBuildRun(input: CreateBuildRunInput): BuildRun {
  return {
    id: input.id,
    title: input.title,
    specPath: input.specPath,
    trackerPath: input.trackerPath,
    transport: input.transport,
    status: "ready",
    tasks: input.tasks.map((task) => ({ title: task.title, status: task.done ? "completed" : "pending" })),
    activeTaskIndex: null,
    log: "",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function buildProgress(run: BuildRun): { completed: number; total: number; percent: number } {
  const completed = run.tasks.filter((task) => task.status === "completed").length;
  const total = run.tasks.length;
  return { completed, total, percent: total === 0 ? 100 : Math.round((completed / total) * 100) };
}

const RUN_STATUSES = new Set<BuildRunStatus>(["ready", "running", "pause_requested", "paused", "cancel_requested", "cancelled", "failed", "interrupted", "completed"]);

export function restoreBuildRuns(value: unknown): BuildRun[] {
  if (!Array.isArray(value)) return [];
  const restored: BuildRun[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<BuildRun>;
    if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.specPath !== "string" || typeof raw.trackerPath !== "string") continue;
    if (raw.transport !== "desktop" && raw.transport !== "cloud") continue;
    if (!raw.status || !RUN_STATUSES.has(raw.status) || !Array.isArray(raw.tasks)) continue;
    const tasks = raw.tasks.flatMap((task) => {
      if (!task || typeof task.title !== "string" || !["pending", "running", "completed"].includes(task.status)) return [];
      return [{ ...task, status: task.status === "running" ? "pending" as const : task.status }];
    });
    const wasActive = ["running", "pause_requested", "cancel_requested"].includes(raw.status);
    restored.push({
      id: raw.id,
      title: raw.title,
      specPath: raw.specPath,
      trackerPath: raw.trackerPath,
      transport: raw.transport,
      status: wasActive ? "interrupted" : raw.status,
      tasks,
      activeTaskIndex: null,
      log: typeof raw.log === "string" ? raw.log.slice(-16_000) : "",
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      ...(typeof raw.sessionUrl === "string" ? { sessionUrl: raw.sessionUrl } : {}),
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    });
  }
  return restored;
}

const cloneRun = (run: BuildRun): BuildRun => ({ ...run, tasks: run.tasks.map((task) => ({ ...task })) });
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const isAbort = (cause: unknown): boolean => cause instanceof DOMException
  ? cause.name === "AbortError"
  : cause instanceof Error && cause.name === "AbortError";

export class BuildRunCoordinator {
  private run: BuildRun;
  private loopPromise: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly maxLogChars: number;

  constructor(run: BuildRun, private readonly options: BuildRunCoordinatorOptions) {
    this.run = cloneRun(run);
    this.now = options.now ?? Date.now;
    this.maxLogChars = Math.max(1, options.maxLogChars ?? 16_000);
  }

  snapshot(): BuildRun {
    return cloneRun(this.run);
  }

  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    if (this.disposed) return Promise.resolve();
    if (!["ready", "paused", "failed", "interrupted"].includes(this.run.status)) return Promise.resolve();
    const generation = ++this.generation;
    this.loopPromise = this.runLoop(generation).finally(() => {
      if (generation === this.generation) this.loopPromise = null;
    });
    return this.loopPromise;
  }

  resume(): Promise<void> {
    return this.start();
  }

  async pause(): Promise<void> {
    if (this.disposed || this.run.status !== "running") return;
    await this.transition({ status: "pause_requested" });
  }

  async cancel(): Promise<void> {
    if (this.disposed || ["cancelled", "completed"].includes(this.run.status)) return;
    if (!this.loopPromise) {
      await this.transition({ status: "cancelled", activeTaskIndex: null });
      return;
    }
    await this.transition({ status: "cancel_requested" });
    if (this.options.executor.cancelMode === "immediate") this.controller?.abort();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (["running", "pause_requested", "cancel_requested"].includes(this.run.status)) {
      const active = this.run.activeTaskIndex;
      const activeTask = active === null ? undefined : this.run.tasks[active];
      if (activeTask?.status === "running") activeTask.status = "pending";
      await this.transition({ status: "interrupted", activeTaskIndex: null });
    }
  }

  private async runLoop(generation: number): Promise<void> {
    const next = this.nextTaskIndex();
    if (next === null) {
      delete this.run.error;
      await this.transition({ status: "completed", activeTaskIndex: null });
      return;
    }
    delete this.run.error;
    await this.transition({ status: "running" });

    while (!this.disposed && generation === this.generation) {
      const index = this.nextTaskIndex();
      if (index === null) {
        await this.transition({ status: "completed", activeTaskIndex: null });
        return;
      }
      const task = this.run.tasks[index]!;
      task.status = "running";
      await this.transition({ activeTaskIndex: index });
      this.controller = new AbortController();
      try {
        const result = await this.options.executor.execute({
          runId: this.run.id,
          title: task.title,
          index,
          total: this.run.tasks.length,
          specPath: this.run.specPath,
          trackerPath: this.run.trackerPath,
          transport: this.run.transport,
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          ...(task.sessionUrl ? { sessionUrl: task.sessionUrl } : {}),
        }, this.controller.signal, (event) => void this.handleEvent(event, index, generation));
        if (this.disposed || generation !== this.generation) return;
        task.status = "completed";
        if (result.summary) task.summary = result.summary;
        await this.transition({
          activeTaskIndex: null,
          ...(result.sessionUrl ? { sessionUrl: result.sessionUrl } : {}),
        });
      } catch (cause) {
        if (this.disposed || generation !== this.generation) return;
        task.status = "pending";
        this.controller = null;
        if (this.run.status === "cancel_requested" && isAbort(cause)) {
          await this.transition({ status: "cancelled", activeTaskIndex: null });
          return;
        }
        await this.transition({ status: "failed", activeTaskIndex: null, error: messageOf(cause) });
        return;
      } finally {
        this.controller = null;
      }

      if (this.run.status === "pause_requested") {
        await this.transition({ status: "paused", activeTaskIndex: null });
        return;
      }
      if (this.run.status === "cancel_requested") {
        await this.transition({ status: "cancelled", activeTaskIndex: null });
        return;
      }
    }
  }

  private nextTaskIndex(): number | null {
    const index = this.run.tasks.findIndex((task) => task.status !== "completed");
    return index < 0 ? null : index;
  }

  private async appendLog(line: string, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const next = `${this.run.log}${this.run.log ? "\n" : ""}${line}`;
    this.run.log = next.slice(-this.maxLogChars);
    await this.transition({});
  }

  private async handleEvent(event: BuildTaskEvent, index: number, generation: number): Promise<void> {
    if (typeof event === "string") {
      await this.appendLog(event, generation);
      return;
    }
    if (this.disposed || generation !== this.generation) return;
    const task = this.run.tasks[index];
    if (!task) return;
    if (event.sessionId) task.sessionId = event.sessionId;
    if (event.sessionUrl) { task.sessionUrl = event.sessionUrl; this.run.sessionUrl = event.sessionUrl; }
    await this.transition({});
  }

  private async transition(patch: Partial<BuildRun>): Promise<void> {
    this.run = { ...this.run, ...patch, updatedAt: this.now() };
    const snapshot = this.snapshot();
    await this.options.persist(snapshot);
    this.options.onChange?.(snapshot);
  }
}
