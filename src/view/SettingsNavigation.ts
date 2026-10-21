import { setIcon, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import { REPOSITORY_URL } from "../project";
import type { PluginSettings } from "../types";
import { searchSettings, settingsSections, settingVisible, type SettingsCategory } from "../settingsItems/navigation";

const CATEGORIES: Array<{ id: SettingsCategory; title: string; icon: string; task: string; description: string }> = [
  { id: "chat", title: "Chat & models", icon: "message-square", task: "Choose how I chat", description: "Pick a provider and model" },
  { id: "vault", title: "Vault access", icon: "file-text", task: "Control access to my notes", description: "Choose what the agent can read or change" },
  { id: "capture", title: "Capture & search", icon: "search", task: "Capture and find knowledge", description: "Clippings, research and search" },
  { id: "connections", title: "Connections", icon: "plug", task: "Connect apps & tools", description: "Use your vault in other apps, or add tools to chat" },
  { id: "files", title: "Files & privacy", icon: "shield", task: "Manage files & privacy", description: "Save locations, memory and data access" },
];
const COMMON_KEYS = new Set(["authMode", "oauthToken", "chatBackend", "model", "customModel", "deviceChatModel", "agentModeEnabled", "agentAllowWrites", "semanticEnabled", "discoveryEnabled", "researchModel", "sourceCaptureEnabled", "ontologyEnabled"]);
const COMMON_NAMES = new Set(["Anthropic API key", "OAuth token", "Environment credential", "Save & test connection", "Codex model", "OpenCode model", "On-device model download", "Embedding model"]);

export interface SettingsNavigationHost {
  update(): void;
  container(): HTMLElement;
  openSetup(): void;
  openDesktop(): void;
}

/** Navigation is transient; every control remains owned by Obsidian's declarative renderer. */
export class SettingsNavigation {
  private advanced = false;
  private category: SettingsCategory | null = null;
  private detail: string | null = null;
  private query = "";
  private expanded = new Set(["permissions", "connection", "files"]);

  constructor(private host: SettingsNavigationHost) {}

  home(): void { this.advanced = false; this.category = null; this.detail = null; this.query = ""; this.refresh(); }
  showTask(category: SettingsCategory): void { this.advanced = false; this.category = category; this.detail = null; this.query = ""; this.refresh(); }
  showAdvanced(category: SettingsCategory = "vault"): void { this.advanced = true; this.category = category; this.detail = null; this.query = ""; this.refresh(); }

  definitions(catalog: SettingDefinitionItem[], settings: PluginSettings): SettingDefinitionItem[] {
    const sections = settingsSections(catalog);
    const searching = this.query.trim().length > 0;
    const selected = searching ? searchSettings(sections, this.query) : sections.filter((section) => section.category === this.category && (!this.detail || section.id === this.detail));
    const home = !searching && this.category === null;
    const connectionChoices = !searching && !this.advanced && this.category === "connections" && !this.detail;
    const items: SettingGroupItem[] = [{ name: "Companion settings", searchable: false, render: (setting, group) => {
      setting.settingEl.empty();
      setting.settingEl.addClass("cc-settings-header");
      group?.listEl.addClass("cc-settings-grid");
      group?.listEl.toggleClass("is-advanced", this.advanced && !searching);
      this.renderHeader(setting.settingEl, settings, home, searching);
    } }];
    // The storage warning is independent of navigation and must never be hidden by a task filter.
    const intro = catalog.find((item) => "type" in item && item.type === "group" && !item.heading);
    if (intro && "items" in intro) items.push(...(intro.items ?? []).filter((item) => "name" in item && item.name === "Credentials are stored in this vault") as SettingGroupItem[]);
    if (home) items.push({ name: "Everyday settings", searchable: false, render: (setting) => {
      setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-home");
      for (const id of ["chat", "vault", "connections", "capture"] as const) {
        const category = CATEGORIES.find((item) => item.id === id)!;
        this.destination(setting.settingEl, category.task, category.description, category.icon, () => this.showTask(id));
      }
      this.destination(setting.settingEl, "Advanced settings", "All controls, connections and technical options", "settings", () => this.showAdvanced(), "cc-settings-advanced-link");
    } });
    else if (connectionChoices) items.push({ name: "Connect apps & tools", searchable: false, render: (setting) => {
      setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-connections");
      const outbound = setting.settingEl.createDiv();
      outbound.createEl("h3", { text: "Use this vault in another app" });
      outbound.createEl("p", { text: "Connect desktop assistants to your Obsidian notes.", cls: "cc-settings-muted" });
      if (sections.some((section) => section.id === "integrations")) this.destination(outbound, "Claude Code", "Uses the official Obsidian CLI", "terminal", () => this.host.openDesktop());
      if (sections.some((section) => section.id === "bridge")) this.destination(outbound, "Claude Desktop", "Uses the optional MCP bridge", "monitor", () => this.openDetail("bridge"));
      if (!sections.some((section) => section.id === "bridge")) outbound.createEl("p", { text: "Desktop app connections are available on desktop.", cls: "cc-settings-muted" });
      const inbound = setting.settingEl.createDiv();
      inbound.createEl("h3", { text: "Add tools to chat" });
      inbound.createEl("p", { text: "Let the chat agent use an external tool server.", cls: "cc-settings-muted" });
      const add = inbound.createEl("button", { text: "Add tool server", cls: "mod-cta" });
      add.addEventListener("click", () => this.openDetail("external-tools"));
      inbound.createEl("p", { text: "You'll confirm every external tool call.", cls: "cc-settings-muted" });
      this.destination(setting.settingEl, "Cloud sessions", "Experimental · Run a session against your vault's Git repository.", "cloud", () => this.openDetail("cloud"), "cc-settings-connection-footer");
      this.destination(setting.settingEl, "Publishing", "Publish notes and artifacts as GitHub Gists", "share", () => this.openDetail("publishing"), "cc-settings-connection-footer");
    } });
    else {
      if (this.advanced && !searching) items.push({ name: "Settings categories", searchable: false, render: (setting) => {
        setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-sidebar");
        setting.settingEl.setCssProps({ "--cc-settings-rows": String(selected.reduce((count, section) => count + section.items.length + 1, 1)) });
        const nav = setting.settingEl.createEl("nav", { attr: { "aria-label": "Settings categories" } });
        for (const category of CATEGORIES) {
          const button = this.destination(nav, category.title, "", category.icon, () => this.showAdvanced(category.id));
          button.toggleClass("is-selected", this.category === category.id);
          if (this.category === category.id) button.setAttribute("aria-current", "page");
        }
      } });
      if (this.advanced && !searching) items.push({ name: "Selected settings category", searchable: false, render: (setting) => {
        setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-category-title");
        setting.settingEl.createEl("h2", { text: CATEGORIES.find((category) => category.id === this.category)?.title ?? "Settings", attr: { tabindex: "-1" } });
      } });
      for (const section of selected) {
        const rows = this.advanced || searching || this.detail ? section.items : section.items.filter((item) => {
          const key = "control" in item ? item.control?.key : undefined;
          return (key && COMMON_KEYS.has(key)) || COMMON_NAMES.has(item.name);
        });
        if (!rows.some(settingVisible)) continue;
        const open = searching || !this.advanced || this.expanded.has(section.id);
        items.push({ name: section.title, searchable: false, render: (setting) => {
          setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-section-heading");
          if (this.advanced && !searching) {
            const button = setting.settingEl.createEl("button", { cls: "cc-settings-disclosure", attr: { "aria-expanded": String(open), "data-cc-section": section.id } });
            button.createSpan({ text: section.title });
            setIcon(button.createSpan({ cls: "cc-settings-chevron" }), open ? "chevron-up" : "chevron-down");
            button.addEventListener("click", () => { if (open) this.expanded.delete(section.id); else this.expanded.add(section.id); this.refresh(`[data-cc-section="${section.id}"]`); });
          } else setting.settingEl.createEl("h3", { text: section.title });
          // Detail copy belongs with the controls, including cloud and credential disclosures.
          if (open && section.description && (this.detail || section.id === "privacy" || section.id === "cloud")) setting.settingEl.createEl("p", { text: section.description, cls: "cc-settings-muted" });
        } });
        if (open) items.push(...rows);
      }
      if (searching && selected.length === 0) items.push({ name: "No matching settings", searchable: false, render: (setting) => {
        setting.settingEl.empty(); setting.settingEl.createEl("p", { text: "No matching settings. Try a provider, feature or setting name.", attr: { role: "status" } });
      } });
      if (!this.advanced && !searching && !this.detail) items.push({ name: "More settings", searchable: false, render: (setting) => {
        setting.settingEl.empty();
        this.destination(setting.settingEl, `More ${CATEGORIES.find((category) => category.id === this.category)?.title.toLowerCase()} settings`, "Open all controls in Advanced settings", "settings", () => this.showAdvanced(this.category ?? "vault"));
      } });
    }
    if (home) items.push({ name: "Open source", searchable: false, render: (setting) => {
      setting.settingEl.empty(); setting.settingEl.addClass("cc-settings-open-source");
      const p = setting.settingEl.createEl("p", { text: "Companion is free and open source. ", cls: "cc-settings-muted" });
      p.createEl("a", { text: "Star on GitHub", attr: { href: REPOSITORY_URL } });
      p.appendText(" · ");
      p.createEl("a", { text: "Report an issue", attr: { href: `${REPOSITORY_URL}/issues` } });
    } });
    return [{ type: "group", cls: "cc-settings-browser", items }];
  }

  private refresh(selector = this.advanced ? ".cc-settings-category-title h2" : ".cc-settings-header h2"): void {
    this.host.update();
    this.host.container().querySelector<HTMLElement>(selector)?.focus();
  }

  private openDetail(id: string): void { this.detail = id; this.query = ""; this.expanded.add(id); this.refresh(); }

  private renderHeader(el: HTMLElement, settings: PluginSettings, home: boolean, searching: boolean): void {
    const breadcrumb = el.createDiv({ cls: "cc-settings-breadcrumb" });
    if (!home) {
      const back = breadcrumb.createEl("button", { text: "Everyday settings", cls: "cc-settings-back" });
      back.addEventListener("click", () => this.home());
      breadcrumb.createSpan({ text: this.advanced ? " / Advanced" : ` / ${CATEGORIES.find((category) => category.id === this.category)?.title ?? "Search"}` });
      if (this.detail) {
        const backToTask = breadcrumb.createEl("button", { text: "Back to connections", cls: "cc-settings-back" });
        backToTask.addEventListener("click", () => this.showTask("connections"));
      }
    }
    if (!this.advanced || searching) el.createEl("h2", { text: home ? "Companion settings" : searching ? "Search settings" : CATEGORIES.find((category) => category.id === this.category)?.task ?? "Settings", attr: { tabindex: "-1" } });
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
    if (home) {
      el.createEl("h3", { text: "What would you like to do?", cls: "cc-settings-home-title" });
      el.createEl("p", { text: "Start with a task. Find detailed controls in Advanced settings.", cls: "cc-settings-muted" });
      if (!settings.setupWizardDone) {
        const setup = el.createDiv({ cls: "cc-settings-setup" });
        const copy = setup.createDiv();
        copy.createEl("strong", { text: "New here? Set up Companion" });
        copy.createEl("p", { text: "Get up and running in a few steps.", cls: "cc-settings-muted" });
        setup.createEl("button", { text: "Get started", cls: "mod-cta" }).addEventListener("click", () => this.host.openSetup());
      }
    } else if (!searching && !this.advanced) el.createEl("p", { text: CATEGORIES.find((category) => category.id === this.category)?.description ?? "", cls: "cc-settings-muted" });
  }

  private destination(el: HTMLElement, title: string, description: string, icon: string, action: () => void, cls = ""): HTMLButtonElement {
    const button = el.createEl("button", { cls: `cc-settings-destination ${cls}` });
    setIcon(button.createSpan({ cls: "cc-settings-icon" }), icon);
    const text = button.createSpan({ cls: "cc-settings-destination-copy" });
    text.createSpan({ text: title, cls: "cc-settings-destination-title" });
    if (description) text.createSpan({ text: description, cls: "cc-settings-muted" });
    setIcon(button.createSpan({ cls: "cc-settings-chevron" }), "chevron-right");
    button.addEventListener("click", action);
    return button;
  }
}
