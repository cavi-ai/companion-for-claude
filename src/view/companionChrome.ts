import { setIcon, type App } from "obsidian";
import type { ActivityStore } from "../activity/store";
import { mountActivityIndicator } from "./ActivityIndicator";
import { QuickOptionsModal, type QuickOptionsModalDependencies } from "./QuickOptionsModal";
import type { CompanionPage } from "./quickOptions";

export interface CompanionChromeDependencies extends QuickOptionsModalDependencies {
  app: App;
  activity: ActivityStore;
  runActivityRecovery?(activityId: string, actionId: string): void | Promise<void>;
  dismissActivity?(activityId: string): void;
}

export interface CompanionChromeOptions {
  /**
   * Mount the controls into an existing actions row instead of creating a
   * header. A page that already has one (chat) must not spend a second full-width
   * row on a single button.
   */
  host?: HTMLElement;
  /** Icon button rather than a labelled one, for hosts that are an icon row. */
  compact?: boolean;
  /** Skip the button where the page reaches quick options another way (mobile ⋯). */
  omitOptionsButton?: boolean;
}

export function renderCompanionChrome(
  root: HTMLElement,
  page: CompanionPage,
  title: string,
  deps: CompanionChromeDependencies,
  options: CompanionChromeOptions = {},
): (remove?: boolean) => void {
  const owned = !options.host;
  const chrome = options.host ?? root.createEl("header", { cls: "cc-companion-chrome" });
  if (owned) chrome.createEl("h2", { cls: "cc-companion-chrome-title", text: title });
  const controls = chrome.createDiv({ cls: "cc-companion-chrome-controls" });
  const activityRoot = controls.createDiv({ cls: "cc-companion-chrome-activity" });
  const unmountActivity = mountActivityIndicator(activityRoot, {
    store: deps.activity,
    runRecovery: (activityId, actionId) => deps.runActivityRecovery
      ? deps.runActivityRecovery(activityId, actionId)
      : deps.run({ id: actionId, page, activityId }),
    dismiss: (activityId) => deps.dismissActivity ? deps.dismissActivity(activityId) : deps.activity.dismiss(activityId),
  });
  if (!options.omitOptionsButton) {
    const optionsButton = controls.createEl("button", {
      cls: options.compact ? "cc-icon-btn cc-companion-quick-options is-compact" : "cc-companion-quick-options",
      attr: { type: "button", "aria-label": `Quick options for ${title}` },
    });
    if (options.compact) setIcon(optionsButton, "sliders-horizontal");
    else optionsButton.setText("Options");
    optionsButton.addEventListener("click", () => new QuickOptionsModal(deps.app, page, deps).open());
  }

  let disposed = false;
  return (remove = true) => {
    if (disposed) return;
    disposed = true;
    unmountActivity(remove);
    // A borrowed host belongs to the caller; only remove what this created.
    if (remove) (owned ? chrome : controls).remove();
  };
}
