import { Modal, Notice, type App } from "obsidian";
import { sanitizeLoadError } from "./shared";

export interface ProjectSourceRecovery {
  projectPath: string;
  sourceTitle: string;
  cause: unknown;
  retry(): Promise<void>;
  openProject(): Promise<void>;
}

export class ProjectSourceRecoveryModal extends Modal {
  private generation = 0;
  constructor(app: App, private readonly recovery: ProjectSourceRecovery) { super(app); }

  override onOpen(): void {
    const generation = ++this.generation;
    const current = () => this.generation === generation;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Project created" });
    this.contentEl.createEl("p", { cls: "cc-research-modal-meta", text: this.recovery.projectPath });
    this.contentEl.createEl("p", { text: `Couldn't add “${this.recovery.sourceTitle}” as its first source. Retry adding the source, or open the project and add it later.` });
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" }, text: sanitizeLoadError(this.recovery.cause) });
    const actions = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
    const retry = actions.createEl("button", { cls: "mod-cta", text: "Retry adding source" });
    const open = actions.createEl("button", { text: "Open project" });
    let busy = false;
    const run = async (addSource: boolean) => {
      if (busy) return;
      busy = true;
      retry.disabled = open.disabled = true;
      status.setText(addSource ? "Adding source…" : "Opening project…");
      error.setText("");
      try {
        if (addSource) await this.recovery.retry();
        if (!current()) return;
        await this.recovery.openProject();
        if (!current()) return;
        if (addSource) new Notice(`Added “${this.recovery.sourceTitle}” to the project.`);
        this.close();
      } catch (cause) {
        if (current()) error.setText(sanitizeLoadError(cause));
      } finally {
        if (current()) {
          busy = false;
          retry.disabled = open.disabled = false;
          status.setText("");
        }
      }
    };
    retry.addEventListener("click", () => void run(true));
    open.addEventListener("click", () => void run(false));
  }

  override onClose(): void { this.generation++; }
}
