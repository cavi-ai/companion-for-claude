import type { ActivityRecord, ActivitySnapshot } from "../activity/store";
import type { ActivityStore } from "../activity/store";

export interface ActivityIndicatorDependencies {
  store: ActivityStore;
  runRecovery(activityId: string, actionId: string): void | Promise<void>;
  dismiss(activityId: string): void;
}

const statePriority: Record<ActivityRecord["state"], number> = {
  "needs-attention": 5,
  running: 4,
  paused: 3,
  succeeded: 2,
  cancelled: 1,
};

const activityLabel = (record: ActivityRecord): string => {
  if (record.state === "needs-attention") return `${record.title}, needs attention`;
  if (record.state === "paused") return `${record.title}, paused`;
  if (record.state === "cancelled") return `${record.title}, cancelled`;
  if (record.state === "succeeded") return `${record.title}, complete`;
  if (record.percent !== undefined) return `${record.title}, ${record.percent}%`;
  return `${record.title}, in progress`;
};

const dominantActivity = (records: ActivityRecord[]): ActivityRecord | undefined =>
  [...records].sort((left, right) => {
    const priority = statePriority[right.state] - statePriority[left.state];
    return priority !== 0 ? priority : right.updatedAt - left.updatedAt;
  })[0];

const stateText = (record: ActivityRecord): string => {
  if (record.state === "needs-attention") return "Needs attention";
  if (record.state === "succeeded") return "Complete";
  if (record.state === "cancelled") return "Cancelled";
  if (record.state === "paused") return "Paused";
  return record.percent === undefined ? "In progress" : `${record.percent}% complete`;
};

const recoveryFailureMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi, "$1")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|password)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

/**
 * Mount the shared Companion activity surface. The returned cleanup function
 * removes the renderer and, critically, releases its store subscription.
 */
export function mountActivityIndicator(
  root: HTMLElement,
  deps: ActivityIndicatorDependencies,
): (remove?: boolean) => void {
  const host = root.createDiv({ cls: "cc-activity-host" });
  let expanded = false;
  let disposed = false;

  const renderRecord = (container: HTMLElement, record: ActivityRecord): void => {
    const details = container.createEl("details", {
      cls: `cc-activity-record is-${record.state}`,
    });
    details.createEl("summary", {
      cls: "cc-activity-summary",
      text: record.title,
      attr: { "aria-label": `Activity details for ${record.title}` },
    });
    const body = details.createDiv({ cls: "cc-activity-record-body" });
    body.createDiv({ cls: "cc-activity-state", text: stateText(record) });
    if (record.currentItem) {
      body.createDiv({ cls: "cc-activity-current", text: record.currentItem });
    }
    if (record.total !== undefined) {
      body.createDiv({
        cls: "cc-activity-counts",
        text: `${record.completed} of ${record.total} · ${record.succeeded} succeeded · ${record.failed} failed`,
      });
    }
    for (const detail of record.details) {
      const row = body.createDiv({ cls: `cc-activity-detail is-${detail.state}` });
      row.createSpan({ cls: "cc-activity-detail-label", text: detail.label });
      row.createSpan({ cls: "cc-activity-detail-message", text: detail.message });
    }
    if (record.technicalDetails) {
      const technical = body.createEl("details", { cls: "cc-activity-technical" });
      technical.createEl("summary", { text: "Technical details" });
      technical.createEl("pre", { text: record.technicalDetails });
    }
    if (record.recovery.length > 0 || record.state !== "running") {
      const actions = body.createDiv({ cls: "cc-activity-actions" });
      for (const action of record.recovery) {
        const button = actions.createEl("button", {
          cls: "cc-activity-action",
          text: action.label,
          attr: { "aria-label": `${action.label} for ${record.title}` },
        });
        button.addEventListener("click", () => {
          void Promise.resolve(deps.runRecovery(record.id, action.id)).catch((error: unknown) => {
            deps.store.fail(record.id, {
              details: [{
                label: action.label,
                message: recoveryFailureMessage(error) || "That recovery action could not be completed.",
                state: "error",
              }],
            });
          });
        });
      }
      if (record.state !== "running") {
        const dismiss = actions.createEl("button", {
          cls: "cc-activity-dismiss",
          text: "Dismiss",
          attr: { "aria-label": `Dismiss ${record.title} activity` },
        });
        dismiss.addEventListener("click", () => deps.dismiss(record.id));
      }
    }
  };

  const render = (snapshot: ActivitySnapshot): void => {
    if (disposed) return;
    host.empty();
    const dominant = dominantActivity(snapshot.records);
    if (!dominant) return;

    const label = activityLabel(dominant);
    const indicator = host.createEl("button", {
      cls: `cc-activity-indicator is-${dominant.state}`,
      attr: {
        type: "button",
        "aria-label": `Companion activity: ${label}`,
        "aria-expanded": String(expanded),
      },
    });
    indicator.createSpan({ cls: "cc-activity-indicator-title", text: dominant.title });
    indicator.createSpan({ cls: "cc-activity-indicator-state", text: stateText(dominant) });
    const progress = indicator.createEl("progress", {
      cls: "cc-activity-progress",
      attr: {
        role: "progressbar",
        "aria-label": `${dominant.title} progress`,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        ...(dominant.percent === undefined
          ? {}
          : { value: String(dominant.percent), max: "100", "aria-valuenow": String(dominant.percent) }),
      },
    });
    if (dominant.percent === undefined) progress.addClass("is-indeterminate");
    indicator.addEventListener("click", () => {
      expanded = !expanded;
      render(snapshot);
    });

    host.createDiv({
      cls: "cc-activity-live",
      text: label,
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });

    if (expanded) {
      const drawer = host.createDiv({
        cls: "cc-activity-drawer",
        attr: { "aria-label": "Companion activity details" },
      });
      for (const record of snapshot.records) renderRecord(drawer, record);
    }
  };

  const unsubscribe = deps.store.subscribe(render);
  return (remove = true) => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (remove) host.remove();
  };
}
