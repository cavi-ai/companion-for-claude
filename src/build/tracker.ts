// Pure generator for the durable Markdown mirror of the native Build Runner.

import { buildProgress, type BuildRun } from "./run";

const STATUS_LABELS: Record<BuildRun["status"], string> = {
  ready: "Ready",
  running: "Running",
  pause_requested: "Pausing after current task",
  paused: "Paused",
  cancel_requested: "Cancelling",
  cancelled: "Cancelled",
  failed: "Needs attention",
  interrupted: "Interrupted",
  completed: "Complete",
};

/** Durable Markdown companion to the native Build Runner view. */
export function trackerNoteBody(run: BuildRun): string {
  const progress = buildProgress(run);
  const lines = [
    `# ${run.title} — build tracker`,
    "",
    `**Status:** ${STATUS_LABELS[run.status]}`,
    `**Progress:** ${progress.completed} / ${progress.total} tasks · ${progress.percent}%`,
    "",
    "## Tasks",
    "",
    ...run.tasks.map((task, index) => `- [${task.status === "completed" ? "x" : " "}] ${index + 1}. ${task.title}${task.summary ? ` — ${task.summary}` : ""}`),
  ];
  if (run.error) lines.push("", "## Needs attention", "", run.error);
  if (run.sessionUrl) lines.push("", "## Cloud session", "", run.sessionUrl);
  if (run.log) lines.push("", "## Recent output", "", "```text", run.log, "```");
  lines.push("");
  return lines.join("\n");
}
