import { Modal, type App } from "obsidian";
import { QUESTION_INSTRUCTION, sanitizeLoadError, type ProjectCreateInput, type RewriteTextFn } from "./shared";

export class ProjectCreateModal extends Modal {
  constructor(app: App, private readonly submit: (input: ProjectCreateInput) => Promise<void>, private readonly rewriteText?: RewriteTextFn, private readonly initial?: Partial<ProjectCreateInput>) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Create research project" });
    this.contentEl.createEl("p", { cls: "cc-research-modal-meta", text: "A project answers one question. You'll add sources, pull passages, make claims, then write." });

    const titleWrap = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    titleWrap.createEl("label", { text: "Title" });
    const title = titleWrap.createEl("input", { attr: { "aria-label": "Project title", placeholder: "Attention residue in remote teams" } });
    if (this.initial?.title) title.value = this.initial.title;

    const questionWrap = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    questionWrap.createEl("label", { text: "Research question" });
    const question = questionWrap.createEl("textarea", { attr: { "aria-label": "Research question", rows: "3", placeholder: "How does task-switching affect deep-work output for remote engineers?" } });
    if (this.initial?.question) question.value = this.initial.question;
    if (this.rewriteText) {
      const draftWrap = questionWrap.createDiv({ cls: "cc-research-modal-actions" });
      const draft = draftWrap.createEl("button", { text: "Draft with Claude", attr: { "aria-label": "Draft a sharp research question with Claude from the title" } });
      draft.addEventListener("click", () => {
        const topic = title.value.trim();
        const seed = question.value.trim();
        if (!topic && !seed) { error.setText("Give the project a title or a rough question first."); return; }
        draft.disabled = true;
        draft.setText("Drafting…");
        error.setText("");
        void this.rewriteText!({ text: seed || topic, instruction: QUESTION_INSTRUCTION, ...(topic ? { context: `Project title: ${topic}` } : {}) })
          .then((result) => { question.value = result; })
          .catch((cause) => error.setText(sanitizeLoadError(cause)))
          .finally(() => { draft.disabled = false; draft.setText("Draft with Claude"); });
      });
    }

    if (this.rewriteText) {
      title.addEventListener("blur", () => {
        const topic = title.value.trim();
        if (!topic || question.value.trim()) return;
        void this.rewriteText!({ text: topic, instruction: QUESTION_INSTRUCTION, context: `Project title: ${topic}` })
          .then((result) => { if (!question.value.trim()) question.value = result; })
          .catch(() => { /* the Draft button reports failures */ });
      });
    }

    const folderWrap = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    folderWrap.createEl("label", { text: "Folder" });
    const folder = folderWrap.createEl("input", { attr: { "aria-label": "Project folder" } });
    let folderTouched = Boolean(this.initial?.folder);
    if (this.initial?.folder) folder.value = this.initial.folder;
    folder.addEventListener("input", () => { folderTouched = true; });
    title.addEventListener("input", () => { if (!folderTouched) folder.value = title.value.trim() ? `Research/${title.value.trim()}` : ""; });

    const audienceWrap = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    audienceWrap.createEl("label", { text: "Who it's for (optional)" });
    const audience = audienceWrap.createEl("input", { attr: { "aria-label": "Audience (optional)" } });

    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const submitBar = this.contentEl.createDiv({ cls: "cc-research-modal-submit-bar" });
    const button = submitBar.createEl("button", { cls: "mod-cta", text: "Create project" });
    button.addEventListener("click", () => {
      const input: ProjectCreateInput = { title: title.value, question: question.value, folder: folder.value, ...(audience.value.trim() ? { audience: audience.value } : {}) };
      if (!input.title.trim() || !input.question.trim() || !input.folder.trim()) { error.setText("Title, research question, and folder are required."); return; }
      void this.submit(input).then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    });
  }
}
