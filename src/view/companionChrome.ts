import type { App } from "obsidian";
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

export function renderCompanionChrome(
  root: HTMLElement,
  page: CompanionPage,
  title: string,
  deps: CompanionChromeDependencies,
  options: { hideTitle?: boolean } = {},
): (remove?: boolean) => void {
  const chrome = root.createEl("header", { cls: "cc-companion-chrome" });
  if (!options.hideTitle) chrome.createEl("h2", { cls: "cc-companion-chrome-title", text: title });
  const controls = chrome.createDiv({ cls: "cc-companion-chrome-controls" });
  const activityRoot = controls.createDiv({ cls: "cc-companion-chrome-activity" });
  const unmountActivity = mountActivityIndicator(activityRoot, {
    store: deps.activity,
    runRecovery: (activityId, actionId) => deps.runActivityRecovery
      ? deps.runActivityRecovery(activityId, actionId)
      : deps.run({ id: actionId, page, activityId }),
    dismiss: (activityId) => deps.dismissActivity ? deps.dismissActivity(activityId) : deps.activity.dismiss(activityId),
  });
  const optionsButton = controls.createEl("button", {
    cls: "cc-companion-quick-options",
    text: "Options",
    attr: { type: "button", "aria-label": `Quick options for ${title}` },
  });
  optionsButton.addEventListener("click", () => new QuickOptionsModal(deps.app, page, deps).open());

  let disposed = false;
  return (remove = true) => {
    if (disposed) return;
    disposed = true;
    unmountActivity(remove);
    if (remove) chrome.remove();
  };
}
