import { setIcon, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import { REPOSITORY_URL } from "../project";
import type { PluginSettings } from "../types";
import { searchSettings, settingsSections, settingVisible, type SettingsCategory } from "../settingsItems/navigation";

const CATEGORIES: Array<{ id: SettingsCategory; title: string }> = [
  { id: "chat", title: "Chat & models" }, { id: "vault", title: "Vault access" },
  { id: "capture", title: "Capture & search" }, { id: "connections", title: "Connections" },
  { id: "files", title: "Files & privacy" },
];

/** A row holding a real dropdown (not Obsidian's transient width-measuring clone). */
const DROPDOWN = ".setting-item-control select:not(.is-measuring)";
const watchedLists = new WeakSet<HTMLElement>();

/** Tag direct rows that hold a dropdown so the stylesheet can lay them out without a relational selector. */
export function markDropdownRows(listEl: HTMLElement): void {
  for (const row of Array.from(listEl.children)) {
    if (row.classList.contains("setting-item")) row.classList.toggle("cc-dropdown-row", row.querySelector(DROPDOWN) !== null);
  }
}

/** Rows render after the header and can re-render in place, so retag on structural changes, at most once per frame. */
export function watchDropdownRows(listEl: HTMLElement): void {
  markDropdownRows(listEl);
  if (watchedLists.has(listEl)) return;
  watchedLists.add(listEl);
  const view = listEl.ownerDocument.defaultView ?? activeWindow;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    view.requestAnimationFrame(() => { queued = false; markDropdownRows(listEl); });
  }).observe(listEl, { childList: true, subtree: true });
}

export interface SettingsNavigationHost {
  update(): void;
  container(): HTMLElement;
}

/** A single level of categories. Search exposes the same controls directly. */
export class SettingsNavigation {
  private category: SettingsCategory = "chat";
  private query = "";
  private history: SettingsCategory[] = [];
  constructor(private host: SettingsNavigationHost) {}

  home(): void { this.category = "chat"; this.query = ""; this.history = []; this.refresh(); }
  showTask(category: SettingsCategory): void {
    if (category !== this.category) this.history.push(this.category);
    this.category = category; this.query = ""; this.refresh();
  }
  showAdvanced(category: SettingsCategory = "vault"): void { this.showTask(category); }

  private back(): void {
    if (this.query) this.query = "";
    else this.category = this.history.pop() ?? "chat";
    this.refresh();
  }

  definitions(catalog: SettingDefinitionItem[], _settings: PluginSettings): SettingDefinitionItem[] {
    const sections = settingsSections(catalog);
    const searching = this.query.trim().length > 0;
    const selected = searching ? searchSettings(sections, this.query) : sections.filter((section) => section.category === this.category);
    const items: SettingGroupItem[] = [{ name: "Companion settings", searchable: false, render: (setting, group) => {
      setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-header");
      if (group) { group.listEl.addClass("cc-settings-grid"); watchDropdownRows(group.listEl); }
      const el = setting.settingEl;
      const navigation = el.createDiv({ cls: "cc-settings-navigation" });
      if (this.history.length || searching) navigation.createEl("button", { text: "Back", cls: "cc-settings-back" }).addEventListener("click", () => this.back());
      const crumb = navigation.createEl("nav", { cls: "cc-settings-breadcrumb", attr: { "aria-label": "Settings breadcrumb" } });
      crumb.createSpan({ text: "Settings" });
      crumb.createSpan({ text: "/", attr: { "aria-hidden": "true" } });
      crumb.createSpan({ text: searching ? "Search results" : CATEGORIES.find((category) => category.id === this.category)!.title, attr: { "aria-current": "page" } });
      el.createEl("h2", { text: "Companion settings", attr: { tabindex: "-1" } });
      const search = el.createDiv({ cls: "cc-settings-search" });
      setIcon(search.createSpan(), "search");
      const input = search.createEl("input", { type: "search", placeholder: "Search all settings…", attr: { "aria-label": "Search all settings" } });
      input.value = this.query;
      input.addEventListener("input", () => {
        this.query = input.value;
        const position = input.selectionStart;
        this.host.update();
        const next = this.host.container().querySelector<HTMLInputElement>(".cc-settings-search input");
        next?.focus();
        if (next && typeof position === "number") next.setSelectionRange(position, position);
      });
      const categories = el.createEl("nav", { cls: "cc-settings-categories", attr: { "aria-label": "Settings categories" } });
      for (const category of CATEGORIES) {
        const button = categories.createEl("button", { text: category.title, attr: { "aria-pressed": String(!searching && category.id === this.category) } });
        button.addEventListener("click", () => this.showTask(category.id));
      }
    } }];
    const intro = catalog.find((definition) => "type" in definition && definition.type === "group" && !definition.heading);
    if (intro && "items" in intro) items.push(...(intro.items ?? []).filter((item) => "name" in item && item.name === "Credentials are stored in this vault") as SettingGroupItem[]);
    for (const section of selected) {
      if (!section.items.some(settingVisible)) continue;
      items.push({ name: section.title, searchable: false, render: (setting) => {
        setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-section-heading");
        setting.settingEl.createEl("h3", { text: section.title });
        if (section.description) setting.settingEl.createEl("p", { text: section.description, cls: "cc-settings-muted" });
      } }, ...section.items);
    }
    if (!selected.length) items.push({ name: "No matching settings", searchable: false, render: (setting) => {
      setting.settingEl.empty(); setting.settingEl.createEl("p", { text: "No matching settings.", attr: { role: "status" } });
    } });
    items.push({ name: "Open source", searchable: false, render: (setting) => {
      setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-open-source");
      setting.settingEl.createEl("a", { text: "Report an issue", href: `${REPOSITORY_URL}/issues` });
    } });
    return [{ type: "group", cls: "cc-settings-browser", items }];
  }

  private refresh(): void {
    this.host.update();
    this.host.container().querySelector<HTMLElement>(".cc-settings-header h2")?.focus();
  }
}
