import { setIcon } from "obsidian";
import type {
  AddedContextItem,
  AutomaticContextKey,
  ContextManagerModel,
  ContextSourceKind,
} from "./contextManagerModel";

export interface ComposerContextManagerCallbacks {
  toggleAutomatic(key: AutomaticContextKey, enabled: boolean): void;
  removeSource(id: string): void;
  retrySource(id: string): void;
  addContext(): void;
}

const SOURCE_ICONS: Record<ContextSourceKind, string> = {
  note: "file-text",
  folder: "folder",
  project: "folder-kanban",
  pdf: "file-type-2",
  image: "image",
  webpage: "globe-2",
};

let managerSequence = 0;

export class ComposerContextManager {
  private readonly root: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly triggerLabel: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly automaticEl: HTMLElement;
  private readonly sourcesEl: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly addButton: HTMLButtonElement;
  private readonly focusTargets = new Map<string, HTMLElement>();
  private openState = false;
  private focusedControlId: string | null = null;

  constructor(parent: HTMLElement, private readonly callbacks: ComposerContextManagerCallbacks) {
    const sequence = managerSequence++;
    const surfaceId = `cc-context-surface-${sequence}`;
    const headingId = `cc-context-heading-${sequence}`;

    this.root = parent.createDiv({ cls: "cc-context-manager" });
    this.trigger = this.root.createEl("button", {
      cls: "cc-context-trigger",
      attr: {
        type: "button",
        "aria-expanded": "false",
        "aria-controls": surfaceId,
        "aria-haspopup": "dialog",
      },
    });
    setIcon(this.trigger.createSpan({ cls: "cc-context-trigger-icon" }), "paperclip");
    this.triggerLabel = this.trigger.createSpan({ cls: "cc-context-trigger-label" });

    this.layer = this.root.createDiv({ cls: "cc-context-layer", attr: { "aria-hidden": "true" } });
    const backdrop = this.layer.createDiv({ cls: "cc-context-backdrop", attr: { "aria-hidden": "true" } });
    this.surface = this.layer.createEl("section", {
      cls: "cc-context-surface",
      attr: { id: surfaceId, role: "dialog", "aria-labelledby": headingId, tabindex: "-1" },
    });
    const header = this.surface.createDiv({ cls: "cc-context-header" });
    header.createEl("h3", { cls: "cc-context-heading", text: "Message context", attr: { id: headingId } });
    this.closeButton = header.createEl("button", {
      cls: "cc-context-close",
      attr: { type: "button", "aria-label": "Close message context" },
    });
    setIcon(this.closeButton, "x");

    const scroll = this.surface.createDiv({ cls: "cc-context-scroll" });
    this.automaticEl = scroll.createEl("section", { cls: "cc-context-section" });
    this.sourcesEl = scroll.createEl("section", { cls: "cc-context-section" });
    const footer = this.surface.createDiv({ cls: "cc-context-footer" });
    this.addButton = footer.createEl("button", {
      cls: "cc-context-add",
      text: "Add context",
      attr: { type: "button", "aria-label": "Add context" },
    });
    setIcon(this.addButton.createSpan({ cls: "cc-context-add-icon" }), "plus");

    this.registerFocus(this.closeButton, "close");
    this.registerFocus(this.addButton, "add");
    this.trigger.addEventListener("click", () => this.openState ? this.close() : this.open());
    backdrop.addEventListener("click", () => this.close());
    this.closeButton.addEventListener("click", () => this.close());
    this.addButton.addEventListener("click", () => this.callbacks.addContext());
    this.surface.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  render(model: ContextManagerModel): void {
    const itemWord = model.activeCount === 1 ? "item" : "items";
    this.trigger.setAttr("aria-label", `Manage context, ${model.activeCount} ${itemWord} active`);
    this.triggerLabel.setText(model.summary);
    this.renderAutomatic(model);
    this.renderSources(model.sources);
    this.restoreTrackedFocus();
  }

  open(): void {
    this.setOpen(true, false);
    this.focusControl(this.firstFocusable());
  }

  close(options: { restoreFocus?: boolean } = {}): void {
    this.setOpen(false, options.restoreFocus ?? true);
  }

  isOpen(): boolean {
    return this.openState;
  }

  destroy(): void {
    this.root.remove();
    this.focusTargets.clear();
  }

  private renderAutomatic(model: ContextManagerModel): void {
    this.automaticEl.empty();
    this.automaticEl.createEl("h4", { cls: "cc-context-section-heading", text: "Automatic context" });
    for (const item of model.automatic) {
      const row = this.automaticEl.createEl("label", { cls: "cc-context-row cc-context-automatic" });
      const checkbox = row.createEl("input", {
        cls: "cc-context-checkbox",
        attr: { type: "checkbox", "aria-label": item.label },
      });
      checkbox.checked = item.enabled;
      const copy = row.createDiv({ cls: "cc-context-copy" });
      copy.createSpan({ cls: "cc-context-source-name", text: item.label });
      if (item.detail) copy.createSpan({ cls: "cc-context-source-detail", text: item.detail, attr: { title: item.detail } });
      this.registerFocus(checkbox, `automatic:${item.key}`);
      checkbox.addEventListener("change", (event) => {
        this.callbacks.toggleAutomatic(item.key, (event.target as HTMLInputElement).checked);
      });
    }
  }

  private renderSources(sources: AddedContextItem[]): void {
    this.sourcesEl.empty();
    this.sourcesEl.createEl("h4", { cls: "cc-context-section-heading", text: "Added sources" });
    if (sources.length === 0) {
      this.sourcesEl.createDiv({ cls: "cc-context-empty", text: "No added sources" });
      return;
    }
    for (const source of sources) this.renderSource(source);
  }

  private renderSource(source: AddedContextItem): void {
    const row = this.sourcesEl.createDiv({
      cls: `cc-context-row cc-context-source is-${source.status}`,
      attr: { "data-context-id": source.id },
    });
    const icon = row.createSpan({ cls: "cc-context-source-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, SOURCE_ICONS[source.kind]);
    const copy = row.createDiv({ cls: "cc-context-copy" });
    copy.createSpan({ cls: "cc-context-source-name", text: source.label, attr: { title: source.label } });
    if (source.detail) copy.createSpan({ cls: "cc-context-source-detail", text: source.detail, attr: { title: source.detail } });
    if (source.status === "pending") {
      copy.createSpan({ cls: "cc-context-source-status", text: "Pending capture", attr: { role: "status" } });
    } else if (source.status === "error") {
      const error = source.error ?? "Capture failed";
      copy.createSpan({ cls: "cc-context-source-error", text: error, attr: { role: "alert", title: error } });
    }
    const actions = row.createDiv({ cls: "cc-context-source-actions" });
    if (source.status === "error") {
      const retry = actions.createEl("button", {
        cls: "cc-context-source-action",
        text: "Retry",
        attr: { type: "button", "aria-label": `Retry ${source.label}` },
      });
      this.registerFocus(retry, `retry:${source.id}`);
      retry.addEventListener("click", () => this.callbacks.retrySource(source.id));
    }
    const remove = actions.createEl("button", {
      cls: "cc-context-source-action is-remove",
      attr: { type: "button", "aria-label": `Remove ${source.label}` },
    });
    setIcon(remove, "x");
    this.registerFocus(remove, `remove:${source.id}`);
    remove.addEventListener("click", () => this.callbacks.removeSource(source.id));
  }

  private registerFocus(element: HTMLElement, id: string): void {
    element.setAttr("data-focus-id", id);
    this.focusTargets.set(id, element);
    element.addEventListener("focus", () => { this.focusedControlId = id; });
  }

  private restoreTrackedFocus(): void {
    if (!this.openState || !this.focusedControlId) return;
    this.focusControl(this.focusTargets.get(this.focusedControlId) ?? this.closeButton);
  }

  private firstFocusable(): HTMLElement | null {
    return this.automaticEl.querySelector("input") ?? this.closeButton;
  }

  private orderedFocusables(): HTMLElement[] {
    const controls: HTMLElement[] = [this.closeButton];
    controls.push(...Array.from(this.automaticEl.querySelectorAll<HTMLElement>("input")));
    controls.push(...Array.from(this.sourcesEl.querySelectorAll<HTMLElement>("button")));
    controls.push(this.addButton);
    return controls.filter((element) => !element.hasAttribute("disabled"));
  }

  private focusControl(element: HTMLElement | null): void {
    if (!element) return;
    this.focusedControlId = element.getAttribute("data-focus-id");
    element.focus();
  }

  private onKeydown(event: KeyboardEvent): void {
    if (!this.openState) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = this.orderedFocusables();
    if (focusables.length === 0) return;
    const current = focusables.findIndex((element) => element.getAttribute("data-focus-id") === this.focusedControlId);
    const next = event.shiftKey
      ? (current <= 0 ? focusables.length - 1 : current - 1)
      : (current + 1) % focusables.length;
    event.preventDefault();
    this.focusControl(focusables[next] ?? null);
  }

  private setOpen(open: boolean, restoreFocus: boolean): void {
    this.openState = open;
    this.layer.toggleClass("is-open", open);
    this.layer.setAttr("aria-hidden", String(!open));
    this.trigger.setAttr("aria-expanded", String(open));
    if (!open && restoreFocus) this.trigger.focus();
  }
}
