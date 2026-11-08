import { setIcon } from "obsidian";
import { PanePopover } from "./panePopover";
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
  let disposed = false;
  let indicator: HTMLButtonElement | null = null;
  let drawer: HTMLElement | null = null;
  let recordsEl: HTMLElement | null = null;
  let popover: PanePopover | null = null;
  let latest = deps.store.snapshot();
  const recordElements = new Map<string, HTMLDetailsElement>();

  const close = (returnFocus = false): void => {
    popover?.dispose();
    popover = null;
    drawer?.remove();
    drawer = null;
    recordsEl = null;
    recordElements.clear();
    indicator?.setAttribute("aria-expanded", "false");
    if (returnFocus) indicator?.focus({ preventScroll: true });
  };

  const renderRecord = (details: HTMLDetailsElement, record: ActivityRecord): void => {
    const technicalOpen = details.querySelector<HTMLDetailsElement>(".cc-activity-technical")?.open ?? false;
    details.empty();
    for (const state of Object.keys(statePriority)) details.toggleClass(`is-${state}`, state === record.state);
    const summary = details.createEl("summary", {
      cls: "cc-activity-summary", text: record.title,
      attr: { "aria-label": `Activity details for ${record.title}`, "data-activity-focus": "summary" },
    });
    summary.setAttribute("data-activity-record", record.id);
    const body = details.createDiv({ cls: "cc-activity-record-body" });
    body.createDiv({ cls: "cc-activity-state", text: stateText(record) });
    if (record.currentItem) body.createDiv({ cls: "cc-activity-current", text: record.currentItem });
    if (record.total !== undefined) body.createDiv({ cls: "cc-activity-counts", text: `${record.completed} of ${record.total} · ${record.succeeded} succeeded · ${record.failed} failed` });
    for (const detail of record.details) {
      const row = body.createDiv({ cls: `cc-activity-detail is-${detail.state}` });
      row.createSpan({ cls: "cc-activity-detail-label", text: detail.label });
      row.createSpan({ cls: "cc-activity-detail-message", text: detail.message });
    }
    if (record.technicalDetails) {
      const technical = body.createEl("details", { cls: "cc-activity-technical" });
      technical.open = technicalOpen;
      technical.createEl("summary", { text: "Technical details", attr: { "data-activity-record": record.id, "data-activity-focus": "technical" } });
      technical.createEl("pre", { text: record.technicalDetails });
    }
    if (record.recovery.length > 0 || record.state !== "running") {
      const actions = body.createDiv({ cls: "cc-activity-actions" });
      for (const action of record.recovery) {
        const button = actions.createEl("button", {
          cls: "cc-activity-action", text: action.label,
          attr: { type: "button", "aria-label": `${action.label} for ${record.title}`, "data-activity-record": record.id, "data-activity-focus": `action:${action.id}` },
        });
        button.addEventListener("click", () => {
          void (async () => {
            try { await deps.runRecovery(record.id, action.id); }
            catch (error: unknown) {
              deps.store.fail(record.id, { details: [{ label: action.label, message: recoveryFailureMessage(error) || "That recovery action could not be completed.", state: "error" }] });
            }
          })();
        });
      }
      if (record.state !== "running") {
        actions.createEl("button", { cls: "cc-activity-dismiss", text: "Dismiss", attr: {
          type: "button", "aria-label": `Dismiss ${record.title} activity`, "data-activity-record": record.id, "data-activity-focus": "dismiss",
        } }).addEventListener("click", () => deps.dismiss(record.id));
      }
    }
  };

  const renderRecords = (): void => {
    if (!recordsEl) return;
    const focused = root.ownerDocument.activeElement as HTMLElement | null;
    const ownedFocus = focused && recordsEl.contains(focused) ? focused : null;
    const focusedRecord = ownedFocus?.getAttribute("data-activity-record");
    const focusKey = ownedFocus?.getAttribute("data-activity-focus");
    const scrollTop = recordsEl.scrollTop;
    for (const [id, element] of recordElements) {
      if (!latest.records.some((record) => record.id === id)) { element.remove(); recordElements.delete(id); }
    }
    for (const record of latest.records) {
      let element = recordElements.get(record.id);
      if (!element) {
        element = recordsEl.createEl("details", { cls: `cc-activity-record is-${record.state}` });
        recordElements.set(record.id, element);
      }
      renderRecord(element, record);
      recordsEl.appendChild(element);
    }
    recordsEl.scrollTop = scrollTop;
    if (focusedRecord && focusKey) {
      const record = recordElements.get(focusedRecord);
      const targets = record ? [...record.querySelectorAll<HTMLElement>("button"), ...record.querySelectorAll<HTMLElement>("summary")] : [];
      const target = targets.find((element) => element.getAttribute("data-activity-focus") === focusKey)
        ?? record?.querySelector<HTMLElement>(".cc-activity-summary")
        ?? recordsEl.querySelector<HTMLElement>(".cc-activity-summary")
        ?? drawer?.querySelector<HTMLElement>(".cc-pane-popover-close");
      target?.focus({ preventScroll: true });
    }
    popover?.reposition();
  };

  const open = (): void => {
    if (!indicator || drawer) return;
    drawer = host.createDiv({ cls: "cc-activity-drawer", attr: { role: "region", "aria-label": "Companion activity details" } });
    const heading = drawer.createDiv({ cls: "cc-pane-popover-header" });
    heading.createEl("h3", { text: "Activity" });
    heading.createEl("button", { cls: "cc-pane-popover-close", text: "Close", attr: { type: "button", "aria-label": "Close activity" } })
      .addEventListener("click", () => close(true));
    recordsEl = drawer.createDiv({ cls: "cc-activity-records cc-pane-popover-body" });
    indicator.setAttribute("aria-expanded", "true");
    popover = new PanePopover({ anchor: indicator, panel: drawer, onDismiss: (reason) => close(reason === "escape") });
    renderRecords();
  };

  const render = (snapshot: ActivitySnapshot): void => {
    if (disposed) return;
    latest = snapshot;
    const dominant = dominantActivity(snapshot.records);
    if (!dominant) {
      const focused = root.ownerDocument.activeElement;
      const restoreFocus = focused && (host.contains(focused) || drawer?.contains(focused));
      const pane = root.closest<HTMLElement>(".cc-chat-root") ?? root.closest<HTMLElement>(".cc-root") ?? root;
      close(); indicator?.remove(); indicator = null; host.empty();
      if (restoreFocus) {
        const candidates = [".cc-input", ".cc-companion-quick-options", ".cc-model", ".cc-sessions-btn", "input", "textarea", "select", "button"]
          .flatMap(selector => [...pane.querySelectorAll<HTMLElement>(selector)]);
        const target = candidates.find(control => control.isConnected !== false
          && !(control as HTMLButtonElement).disabled && control.getAttribute("aria-disabled") !== "true"
          && control.getAttribute("hidden") === null
          && (typeof control.checkVisibility !== "function" || control.checkVisibility({ checkVisibilityCSS: true })));
        target?.focus({ preventScroll: true });
      }
      return;
    }
    if (!indicator) {
      indicator = host.createEl("button", { cls: "cc-activity-indicator", attr: { type: "button", "aria-expanded": "false" } });
      indicator.createSpan({ cls: "cc-activity-indicator-icon", attr: { "aria-hidden": "true" } });
      indicator.createSpan({ cls: "cc-activity-indicator-title", text: "Activity" });
      indicator.createSpan({ cls: "cc-activity-indicator-count", attr: { "aria-hidden": "true" } });
      indicator.createEl("progress", { cls: "cc-activity-progress", attr: { role: "progressbar", "aria-label": "Activity progress", "aria-valuemin": "0", "aria-valuemax": "100" } });
      indicator.addEventListener("click", () => drawer ? close() : open());
      host.createDiv({ cls: "cc-activity-live", attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" } });
    }
    for (const state of Object.keys(statePriority)) indicator.toggleClass(`is-${state}`, state === dominant.state);
    const label = `Activity: ${snapshot.records.length} ${snapshot.records.length === 1 ? "task" : "tasks"}, ${stateText(dominant)}`;
    indicator.setAttribute("aria-label", label);
    indicator.setAttribute("title", label);
    const icon = indicator.querySelector<HTMLElement>(".cc-activity-indicator-icon")!;
    setIcon(icon, dominant.state === "needs-attention" ? "circle-alert" : dominant.state === "running" ? "loader-circle" : dominant.state === "paused" ? "pause" : dominant.state === "succeeded" ? "check" : "circle-slash");
    indicator.querySelector<HTMLElement>(".cc-activity-indicator-count")!.setText(String(snapshot.records.length));
    const progress = indicator.querySelector<HTMLElement>(".cc-activity-progress")!;
    progress.toggleClass("is-indeterminate", dominant.percent === undefined);
    if (dominant.percent === undefined) { progress.removeAttribute("value"); progress.removeAttribute("aria-valuenow"); }
    else { progress.setAttribute("value", String(dominant.percent)); progress.setAttribute("max", "100"); progress.setAttribute("aria-valuenow", String(dominant.percent)); }
    host.querySelector<HTMLElement>(".cc-activity-live")!.setText(label);
    renderRecords();
  };

  const unsubscribe = deps.store.subscribe(render);
  return (remove = true) => {
    if (disposed) return;
    disposed = true;
    close();
    unsubscribe();
    if (remove) host.remove();
  };
}
