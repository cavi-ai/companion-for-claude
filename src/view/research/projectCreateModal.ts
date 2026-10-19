import { Modal, type App } from "obsidian";
import { QUESTION_INSTRUCTION, sanitizeLoadError, type ProjectCreateInput, type RewriteTextFn } from "./shared";

export class ProjectCreateModal extends Modal {
  private generation = 0;
  constructor(app: App, private readonly submit: (input: ProjectCreateInput) => Promise<void>, private readonly rewriteText?: RewriteTextFn, private readonly initial?: Partial<ProjectCreateInput>) { super(app); }
  override onOpen(): void {
    const generation = ++this.generation;
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
      let questionRevision = 0;
      let titleRevision = 0;
      let request = 0;
      let pendingTitle: number | undefined;
      let suggestion: HTMLElement | undefined;
      const dismissSuggestion = () => { suggestion?.remove(); suggestion = undefined; };
      question.addEventListener("input", () => { questionRevision++; });
      title.addEventListener("input", () => { titleRevision++; dismissSuggestion(); });
      const draftWrap = questionWrap.createDiv({ cls: "cc-research-modal-actions" });
      const draft = draftWrap.createEl("button", { text: "Draft with Claude", attr: { "aria-label": "Draft a sharp research question with Claude from the title" } });
      const offerSuggestion = (result: string) => {
        dismissSuggestion();
        suggestion = questionWrap.createDiv({ cls: "cc-research-question-suggestion cc-research-modal-field", attr: { role: "region", "aria-label": "Suggested research question" } });
        suggestion.createEl("p", { text: "Your edits were kept. You can use this suggestion instead.", attr: { role: "status" } });
        suggestion.createEl("p", { text: result });
        const actions = suggestion.createDiv({ cls: "cc-research-modal-actions" });
        actions.createEl("button", { text: "Use suggested question" }).addEventListener("click", () => {
          question.value = result;
          questionRevision++;
          dismissSuggestion();
        });
        actions.createEl("button", { text: "Dismiss suggestion" }).addEventListener("click", dismissSuggestion);
      };
      const draftQuestion = (explicit: boolean) => {
        const topic = title.value.trim();
        const seed = question.value.trim();
        if (!topic && !seed) { error.setText("Give the project a title or a rough question first."); return; }
        if (pendingTitle === titleRevision) return;
        const owner = ++request;
        const fromTitle = titleRevision;
        const fromQuestion = questionRevision;
        pendingTitle = fromTitle;
        const current = () => this.generation === generation && request === owner;
        draft.disabled = true;
        draft.setText("Drafting…");
        dismissSuggestion();
        error.setText("");
        void Promise.resolve().then(() => this.rewriteText!({ text: seed || topic, instruction: QUESTION_INSTRUCTION, ...(topic ? { context: `Project title: ${topic}` } : {}) }))
          .then((result) => {
            if (!current() || titleRevision !== fromTitle) return;
            if (questionRevision === fromQuestion) question.value = result;
            else offerSuggestion(result);
          })
          .catch((cause) => { if (current() && titleRevision === fromTitle && explicit) error.setText(sanitizeLoadError(cause)); })
          .finally(() => {
            if (!current()) return;
            pendingTitle = undefined;
            draft.disabled = false;
            draft.setText("Draft with Claude");
          });
      };
      draft.addEventListener("click", () => draftQuestion(true));
      title.addEventListener("blur", () => {
        if (title.value.trim() && !question.value.trim()) draftQuestion(false);
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
  override onClose(): void { this.generation++; }
}
