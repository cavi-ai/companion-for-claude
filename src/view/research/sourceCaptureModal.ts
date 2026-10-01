import { FuzzySuggestModal, Modal, type App, type TFile } from "obsidian";
import { sanitizeLoadError } from "./shared";

export interface SourceCaptureHandlers {
  /** Clip a URL to clean markdown, import it, tag it. Returns a status message. */
  captureUrl(url: string): Promise<string>;
  /** Import dropped/uploaded files (md → text capture; others → project assets). Returns a status message. */
  importFiles(files: Array<{ name: string; size: number; read(): Promise<ArrayBuffer> }>): Promise<string>;
  /** Fuzzy-pick a vault note and import it. Resolves null when cancelled. */
  pickNote(): Promise<string | null>;
}

function extractUrl(text: string): string | undefined {
  return /https?:\/\/[^\s<>"']+/.exec(text.trim())?.[0];
}

/**
 * Capture-first source intake: no form fields. Drop a URL or file, paste a
 * link, pick a note, or upload — each gesture is one action with an inline
 * status line instead of a multi-field dialog.
 */
export class SourceCaptureModal extends Modal {
  private busy = false;

  constructor(app: App, private readonly handlers: SourceCaptureHandlers) { super(app); }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("cc-source-capture");
    this.contentEl.createEl("h2", { text: "Add research source" });
    this.contentEl.createEl("p", { cls: "cc-research-modal-meta", text: "Drop a link or file, paste a URL, or pick a note. URLs are clipped to clean markdown and tagged automatically — no forms." });

    const status = this.contentEl.createEl("p", { cls: "cc-source-capture-status", attr: { role: "status" } });
    const run = (label: string, action: () => Promise<string | null>) => {
      if (this.busy) return;
      this.busy = true;
      status.setText(`${label}…`);
      void action()
        .then((message) => status.setText(message ?? ""))
        .catch((cause) => status.setText(sanitizeLoadError(cause)))
        .finally(() => { this.busy = false; });
    };
    const readFiles = (list: FileList | File[]) => {
      const files = [...list];
      if (!files.length) return;
      run(
        `Importing ${files.length} file${files.length === 1 ? "" : "s"}`,
        () => this.handlers.importFiles(files.map((file) => ({ name: file.name, size: file.size, read: () => file.arrayBuffer() }))),
      );
    };

    const drop = this.contentEl.createDiv({ cls: "cc-source-dropzone", text: "Drop a URL, PDF, or file here" });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.addClass("is-dragover"); });
    drop.addEventListener("dragleave", () => drop.removeClass("is-dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.removeClass("is-dragover");
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files.length) { readFiles(dt.files); return; }
      const url = extractUrl(dt.getData("text/uri-list") || dt.getData("text/plain"));
      if (url) run("Clipping", () => this.handlers.captureUrl(url));
      else status.setText("Drop a link or a file — that wasn't recognizable.");
    });

    const urlRow = this.contentEl.createDiv({ cls: "cc-source-url-row" });
    const urlInput = urlRow.createEl("input", { attr: { type: "url", placeholder: "https://… paste a link to clip", "aria-label": "URL to clip" } });
    const clip = urlRow.createEl("button", { cls: "mod-cta", text: "Clip & add" });
    const submitUrl = () => {
      const url = extractUrl(urlInput.value);
      if (!url) { status.setText("Paste a valid http(s) URL first."); return; }
      run("Clipping", () => this.handlers.captureUrl(url));
    };
    clip.addEventListener("click", submitUrl);
    urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitUrl(); } });

    const actions = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
    const pick = actions.createEl("button", { text: "Choose a vault note…" });
    pick.addEventListener("click", () => run("Importing note", () => this.handlers.pickNote()));
    const upload = actions.createEl("button", { text: "Upload a file…" });
    const fileInput = this.contentEl.createEl("input", { attr: { type: "file", multiple: "multiple", "aria-label": "Upload source files" } });
    fileInput.addClass("cc-source-file-input");
    upload.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => { if (fileInput.files?.length) readFiles(fileInput.files); });
  }
}

export class NotePickModal extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(app: App, private readonly choose: (file: TFile) => void, private readonly cancel: () => void) { super(app); }

  override getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(file: TFile): string { return file.path; }

  onChooseItem(file: TFile): void { this.chosen = true; this.choose(file); }

  override onClose(): void { if (!this.chosen) this.cancel(); }
}
