import { ItemView, WorkspaceLeaf } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import type { SafeFix } from "../health/controller";
import type { HealthAction, HealthGroup, HealthReport, HealthSection } from "../health/scan";
import { renderCompanionChrome } from "./companionChrome";

export const SYSTEM_VIEW_TYPE = "claude-system";

export interface SystemViewDeps {
  scan(): Promise<HealthReport>;
  safeFixes(): SafeFix[];
  openNote(path: string): void;
  openResearchDesk(projectPath: string): Promise<void>;
  buildIndex(): Promise<void>;
  catchUpIndex(): Promise<void>;
  openInbox(): Promise<void>;
  reviewSafeFixes(fixes: SafeFix[], done: () => void): void;
  reviewTagMerges(done: () => void): void;
  connectOrphans(done: () => void): void;
  typeUntypedNotes(done: () => void): void;
  openSetupWizard(): void;
  openSettings(): void;
  openClipperSetup(): void;
  runActivityRecovery(activityId: string, actionId: string): void | Promise<void>;
}

const GROUPS: Array<{ id: HealthGroup; label: string }> = [{ id: "companion", label: "COMPANION" }, { id: "vault", label: "VAULT" }];

/** One local scan per open or Refresh; never on a timer or vault event. */
export class SystemView extends ItemView {
  private disposeChrome: ((remove?: boolean) => void) | null = null;
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: ClaudeCompanionPlugin, private deps: SystemViewDeps) {
    super(leaf);
  }

  override getViewType(): string {
    return SYSTEM_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return "System";
  }
  override getIcon(): string {
    return "heart-pulse";
  }

  override async onOpen(): Promise<void> {
    await this.render();
  }

  override async onClose(): Promise<void> {
    this.generation++;
    this.disposeChrome?.(false);
    this.disposeChrome = null;
  }

  async render(): Promise<void> {
    const generation = ++this.generation;
    const root = this.contentEl;
    this.disposeChrome?.();
    this.disposeChrome = null;
    root.empty();
    root.addClass("cc-system-view");
    this.disposeChrome = renderCompanionChrome(root, "system", "System", this.plugin.companionChrome());
    root.createDiv({ cls: "cc-eyebrow", text: "SYSTEM" });
    const bar = root.createDiv({ cls: "cc-system-bar" });
    const refresh = bar.createEl("button", { cls: "cc-system-refresh", text: "Refresh" });
    refresh.addEventListener("click", () => void this.render());
    const scanned = bar.createSpan({ cls: "cc-system-scanned", text: "Scanning…" });

    let report: HealthReport;
    try {
      report = await this.deps.scan();
    } catch (error) {
      if (generation !== this.generation) return;
      scanned.setText(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (generation !== this.generation) return;
    scanned.setText(`Scanned ${new Date(report.scannedAt).toLocaleTimeString()}`);

    const problems = report.sections.filter((s) => s.severity !== "ok");
    if (problems.length === 0) {
      root.createEl("p", { cls: "cc-system-ok", text: "Everything checks out." });
    } else {
      for (const group of GROUPS) {
        root.createDiv({ cls: "cc-system-group", text: group.label });
        const rows = problems.filter((s) => s.group === group.id);
        if (rows.length === 0) root.createEl("p", { cls: "cc-system-group-ok", text: "All good." });
        for (const section of rows) this.renderSection(root, section);
      }
    }
    const footer = root.createEl("button", { cls: "cc-system-settings", text: "Open Companion settings" });
    footer.addEventListener("click", () => this.deps.openSettings());
  }

  private renderSection(root: HTMLElement, section: HealthSection): void {
    const card = root.createDiv({ cls: `cc-system-section cc-system-${section.id} is-${section.severity}` });
    card.createDiv({ cls: "cc-system-title", text: `${section.title} · ${section.count}` });
    for (const item of section.items) {
      const row = card.createDiv({ cls: "cc-system-row" });
      if (item.path) {
        const link = row.createEl("button", { cls: "cc-system-link", text: item.path });
        link.addEventListener("click", () => this.deps.openNote(item.path));
      }
      row.createSpan({ cls: "cc-system-message", text: item.message });
    }
    if (!section.summary && section.count > section.items.length) {
      card.createDiv({ cls: "cc-system-more", text: `+${section.count - section.items.length} more` });
    }
    this.renderActions(card, section);
  }

  private renderActions(card: HTMLElement, section: HealthSection): void {
    const actions = card.createDiv({ cls: "cc-system-actions" });
    const action = (text: string, run: () => void | Promise<void>, title?: string): void => {
      const button = actions.createEl("button", { cls: "cc-system-action", text });
      if (title) button.setAttribute("title", title);
      button.addEventListener("click", () => void Promise.resolve(run()));
    };
    const then = (run: () => Promise<void>) => async (): Promise<void> => {
      await run();
      await this.render();
    };
    for (const a of section.actions ?? []) action(a.label, () => this.dispatch(a));
    switch (section.id) {
      case "connection":
      case "activity":
      case "bridge":
      case "clipper":
        return;
      case "ontology":
        if ((section.fixable ?? 0) > 0) {
          action(`Review safe fixes (${section.fixable})`, () => this.deps.reviewSafeFixes(this.deps.safeFixes(), () => void this.render()));
        }
        return;
      case "research":
        for (const project of new Set(section.items.flatMap((i) => (i.project ? [i.project] : [])))) {
          action("Open in Research Desk", () => this.deps.openResearchDesk(project), project);
        }
        return;
      case "index":
        if (section.items.some((i) => i.path === "")) action("Build index", then(() => this.deps.buildIndex()));
        if (section.items.some((i) => i.path !== "")) action("Catch up index", then(() => this.deps.catchUpIndex()));
        return;
      case "inbox":
        action("Open Inbox", () => this.deps.openInbox());
        return;
      case "tags":
        if (section.count > 0) action("Review tag merges", () => this.deps.reviewTagMerges(() => void this.render()));
        return;
      case "orphans":
        if (section.count > 0) action("Connect orphan notes", () => this.deps.connectOrphans(() => void this.render()));
        return;
      case "untyped":
        if (section.count > 0) action("Type untyped notes", () => this.deps.typeUntypedNotes(() => void this.render()));
        return;
      case "links":
        return;
    }
  }

  private dispatch(action: HealthAction): void | Promise<void> {
    if (action.activityId) return this.deps.runActivityRecovery(action.activityId, action.id);
    switch (action.id) {
      case "open-setup-wizard": return this.deps.openSetupWizard();
      case "open-settings": return this.deps.openSettings();
      case "clipper-schemas": return this.deps.openClipperSetup();
      case "open-note": return action.path ? this.deps.openNote(action.path) : undefined;
    }
  }
}
