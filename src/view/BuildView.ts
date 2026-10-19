import { ItemView, type WorkspaceLeaf } from "obsidian";
import { buildProgress, type BuildRun } from "../build/run";

export const BUILD_VIEW_TYPE = "claude-build-runner";

export interface BuildViewDependencies {
  getRun(): BuildRun | null;
  getRuns(): BuildRun[];
  selectRun(id: string): void | Promise<void>;
  subscribe(listener: (run: BuildRun) => void): () => void;
  start(): void | Promise<void>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  cancel(): void | Promise<void>;
  openSpec(): void | Promise<void>;
  openTracker(): void | Promise<void>;
  retryTracker(): void | Promise<void>;
  openSession(): void | Promise<void>;
}

const visible = (element: HTMLElement, show: boolean): void => {
  if (show) element.removeAttribute("hidden");
  else element.setAttr("hidden", "");
};

function statusCopy(run: BuildRun): string {
  switch (run.status) {
    case "ready": return `Ready · ${run.tasks.length} task${run.tasks.length === 1 ? "" : "s"}`;
    case "running": return `Running task ${(run.activeTaskIndex ?? 0) + 1} of ${run.tasks.length}`;
    case "pause_requested": return "Pausing after the current task";
    case "paused": return "Build paused";
    case "cancel_requested": return run.transport === "cloud" ? "Cancelling after the current cloud task" : "Cancelling build";
    case "cancelled": return "Build cancelled";
    case "failed": return "Build needs attention";
    case "interrupted": return "Build interrupted · ready to resume";
    case "completed": return "Build complete";
  }
}

export class BuildView extends ItemView {
  private disposeSubscription: (() => void) | null = null;
  private run: BuildRun | null = null;
  private runPicker!: HTMLSelectElement;
  private runOptionsKey = "";
  private titleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private progressEl!: HTMLProgressElement;
  private progressTextEl!: HTMLElement;
  private currentTaskEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private cloudBoundaryEl!: HTMLElement;
  private logEl!: HTMLElement;
  private taskListEl!: HTMLElement;
  private taskRows: HTMLElement[] = [];
  private runSections: HTMLElement[] = [];
  private startButton!: HTMLButtonElement;
  private pauseButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;
  private sessionButton!: HTMLButtonElement;
  private retryTrackerButton!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private readonly dependencies: BuildViewDependencies) {
    super(leaf);
  }

  override getViewType(): string { return BUILD_VIEW_TYPE; }
  override getDisplayText(): string { return "Build Runner"; }
  override getIcon(): string { return "hammer"; }

  override async onOpen(): Promise<void> {
    this.buildDom();
    this.disposeSubscription = this.dependencies.subscribe((run) => this.setRun(run));
    this.setRun(this.dependencies.getRun());
  }

  override async onClose(): Promise<void> {
    this.disposeSubscription?.();
    this.disposeSubscription = null;
  }

  setRun(run: BuildRun | null): void {
    this.run = run;
    for (const section of this.runSections) visible(section, !!run);
    this.updateRunPicker(run);
    if (!run) {
      this.titleEl.setText("No build selected");
      this.statusEl.setText("Create a plan and choose Build to begin.");
      visible(this.progressEl, false);
      visible(this.currentTaskEl, false);
      visible(this.startButton, false);
      visible(this.pauseButton, false);
      visible(this.cancelButton, false);
      visible(this.errorEl, false);
      visible(this.cloudBoundaryEl, false);
      visible(this.sessionButton, false);
      visible(this.retryTrackerButton, false);
      return;
    }

    this.titleEl.setText(run.title);
    this.statusEl.setText(statusCopy(run));
    const progress = buildProgress(run);
    this.progressEl.setAttr("value", String(progress.completed));
    this.progressEl.setAttr("max", String(Math.max(1, progress.total)));
    this.progressEl.setAttr("aria-valuenow", String(progress.percent));
    this.progressEl.setAttr("aria-valuetext", `${progress.completed} of ${progress.total} tasks complete`);
    visible(this.progressEl, true);
    this.progressTextEl.setText(`${progress.completed} / ${progress.total} tasks · ${progress.percent}%`);

    const active = run.activeTaskIndex === null ? null : run.tasks[run.activeTaskIndex];
    this.currentTaskEl.setText(active ? `Current task · ${active.title}` : "");
    visible(this.currentTaskEl, !!active);
    this.errorEl.setText([run.error, run.trackerError].filter(Boolean).join("\n"));
    visible(this.errorEl, !!run.error || !!run.trackerError);
    visible(this.retryTrackerButton, !!run.trackerError);
    this.logEl.setText(run.log || "No output yet.");

    const resumable = ["paused", "failed", "interrupted"].includes(run.status);
    visible(this.startButton, run.status === "ready" || resumable);
    this.startButton.setText(run.status === "ready" ? "Start build" : run.status === "failed" ? "Retry task" : "Resume build");
    this.startButton.setAttr("aria-label", this.startButton.textContent ?? "Start build");
    visible(this.pauseButton, run.status === "running" || run.status === "pause_requested");
    this.pauseButton.setText(run.status === "pause_requested" ? "Pausing…" : "Pause after current task");
    this.pauseButton.disabled = run.status === "pause_requested";
    const cancellable = ["running", "pause_requested", "paused", "cancel_requested"].includes(run.status);
    visible(this.cancelButton, cancellable);
    this.cancelButton.setText(run.transport === "cloud" ? "Cancel after current task" : "Cancel build");
    this.cancelButton.disabled = run.status === "cancel_requested";
    this.cloudBoundaryEl.setText("Cloud Pause and Cancel stop future tasks. The current cloud task may finish because Claude Routines does not expose remote session cancellation.");
    visible(this.cloudBoundaryEl, run.transport === "cloud" && cancellable);
    visible(this.sessionButton, !!run.sessionUrl);
    this.updateTasks(run);
  }

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-build-view");
    root.createDiv({ cls: "cc-eyebrow", text: "BUILD RUNNER" });
    const pickerLabel = root.createEl("label", { cls: "cc-build-picker" });
    pickerLabel.createSpan({ text: "Saved build" });
    this.runPicker = pickerLabel.createEl("select", { attr: { "aria-label": "Saved build" } });
    this.runOptionsKey = "";
    this.runPicker.addEventListener("change", () => void this.dependencies.selectRun(this.runPicker.value));
    this.titleEl = root.createEl("h2", { cls: "cc-build-title" });
    this.statusEl = root.createDiv({ cls: "cc-build-status", attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" } });
    const progressGroup = root.createDiv({ cls: "cc-build-progress" });
    this.progressEl = progressGroup.createEl("progress", { attr: { role: "progressbar", "aria-label": "Build progress", max: "1", value: "0" } });
    this.progressTextEl = progressGroup.createDiv({ cls: "cc-build-progress-text" });
    this.currentTaskEl = root.createDiv({ cls: "cc-build-current-task" });
    this.errorEl = root.createDiv({ cls: "cc-build-error", attr: { role: "alert" } });
    this.cloudBoundaryEl = root.createDiv({ cls: "cc-build-cloud-boundary" });

    const actions = root.createDiv({ cls: "cc-build-actions" });
    this.startButton = actions.createEl("button", { cls: "mod-cta cc-build-start", text: "Start build" });
    this.pauseButton = actions.createEl("button", { cls: "cc-build-pause", text: "Pause after current task", attr: { "aria-label": "Pause after current task" } });
    this.cancelButton = actions.createEl("button", { cls: "mod-warning cc-build-cancel", text: "Cancel build", attr: { "aria-label": "Cancel build" } });
    const links = root.createDiv({ cls: "cc-build-links" });
    const specButton = links.createEl("button", { cls: "cc-build-link", text: "Open spec" });
    const trackerButton = links.createEl("button", { cls: "cc-build-link", text: "Open tracker note" });
    this.retryTrackerButton = links.createEl("button", { cls: "cc-build-link cc-build-retry-tracker", text: "Retry tracker update" });
    this.sessionButton = links.createEl("button", { cls: "cc-build-link cc-build-session", text: "Open cloud session" });
    this.taskListEl = root.createDiv({ cls: "cc-build-task-list", attr: { "aria-label": "Build tasks" } });
    const output = root.createEl("details", { cls: "cc-build-output" });
    output.createEl("summary", { text: "Build output" });
    this.logEl = output.createEl("pre", { cls: "cc-build-log" });
    this.runSections = [progressGroup, actions, links, this.taskListEl, output];

    this.startButton.addEventListener("click", () => void (this.run?.status === "ready" ? this.dependencies.start() : this.dependencies.resume()));
    this.pauseButton.addEventListener("click", () => void this.dependencies.pause());
    this.cancelButton.addEventListener("click", () => void this.dependencies.cancel());
    specButton.addEventListener("click", () => void this.dependencies.openSpec());
    trackerButton.addEventListener("click", () => void this.dependencies.openTracker());
    this.retryTrackerButton.addEventListener("click", () => void this.dependencies.retryTracker());
    this.sessionButton.addEventListener("click", () => void this.dependencies.openSession());
  }

  private updateTasks(run: BuildRun): void {
    if (this.taskRows.length !== run.tasks.length) {
      this.taskListEl.empty();
      this.taskRows = run.tasks.map(() => this.taskListEl.createDiv({ cls: "cc-build-task" }));
    }
    run.tasks.forEach((task, index) => {
      const row = this.taskRows[index]!;
      row.setText(`${task.status === "completed" ? "✓" : task.status === "running" ? "●" : "○"} ${task.title}`);
      row.toggleClass("is-complete", task.status === "completed");
      row.toggleClass("is-running", task.status === "running");
    });
  }

  private updateRunPicker(selected: BuildRun | null): void {
    const runs = this.dependencies.getRuns();
    const key = JSON.stringify(runs.map((run) => [run.id, run.title, run.status, run.activeTaskIndex, run.tasks.length, run.createdAt]));
    if (key !== this.runOptionsKey) {
      this.runOptionsKey = key;
      this.runPicker.empty();
      runs.forEach((run, index) => {
        this.runPicker.createEl("option", {
          text: `${index + 1}. ${run.title} · ${statusCopy(run)} · ${new Date(run.createdAt).toLocaleString()}`,
          attr: { value: run.id },
        });
      });
    }
    this.runPicker.disabled = runs.length === 0;
    this.runPicker.value = selected?.id ?? "";
  }
}
