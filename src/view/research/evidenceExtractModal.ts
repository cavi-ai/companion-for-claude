import { Modal, Notice, type App } from "obsidian";
import { samePassageExcerpt, type ProposedPassage } from "../../research/evidenceExtraction";
import type { ResearchSourceRecord, SourceLocatorKind } from "../../research/types";
import { sanitizeLoadError } from "./shared";

const LOCATOR_KINDS: SourceLocatorKind[] = ["page", "section", "paragraph", "timestamp", "quote"];

export type PassageLoad =
  | { kind: "passages"; passages: ProposedPassage[] }
  | { kind: "no-text" }
  | { kind: "failed"; reason: string }
  | { kind: "none" };

export interface NewPassage {
  source: string;
  title: string;
  excerpt: string;
  locatorKind?: SourceLocatorKind;
  locatorValue?: string;
  interpretation?: string;
  reviewState: "reviewed" | "proposed";
  model?: string;
}

export interface EvidenceExtractDeps {
  sources: ResearchSourceRecord[];
  initialSource: string;
  label?: string;
  load(sourcePath: string): Promise<PassageLoad>;
  create(passage: NewPassage): Promise<void>;
  changed(): Promise<void>;
}

interface Card { source: string; check: HTMLInputElement; title: HTMLInputElement; excerpt: string; kind: HTMLSelectElement; value: HTMLInputElement; interpretation: HTMLTextAreaElement; root: HTMLElement }
interface SourceWork { root: HTMLElement; count(): number; refresh(): void }

const plural = (count: number): string => `${count} ${count === 1 ? "passage" : "passages"}`;

export class EvidenceExtractModal extends Modal {
  private open_ = true;
  private saving = false;
  private readonly work = new Map<string, SourceWork>();
  constructor(app: App, private readonly deps: EvidenceExtractDeps) { super(app); }

  override onClose(): void { this.open_ = false; }

  override onOpen(): void {
    const { sources } = this.deps;
    this.open_ = true;
    this.work.clear();
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Pull passages from a source" });
    const sourceField = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    sourceField.createEl("label", { text: "Source" });
    const picker = sourceField.createEl("select", { attr: { "aria-label": "Source" } });
    for (const source of sources) picker.createEl("option", { text: source.title, value: source.path });
    picker.value = this.deps.initialSource;
    const host = this.contentEl.createDiv({ cls: "cc-research-source-work" });
    const show = (): void => {
      if (this.saving) return;
      const source = picker.value;
      host.empty();
      const previous = this.work.get(source);
      if (previous) { host.appendChild(previous.root); return; }
      const root = host.createDiv();
      this.work.set(source, this.renderSource(root, source, picker));
    };
    picker.addEventListener("change", show);
    show();
  }

  private setSaving(picker: HTMLSelectElement, saving: boolean): void {
    this.saving = saving;
    picker.disabled = saving;
    for (const work of this.work.values()) {
      for (const tag of ["input", "select", "textarea", "button"]) {
        for (const control of work.root.querySelectorAll<HTMLInputElement>(tag)) control.disabled = saving;
      }
      work.refresh();
    }
  }

  private renderSource(root: HTMLElement, source: string, picker: HTMLSelectElement): SourceWork {
    const { label } = this.deps;
    const status = root.createEl("p", { cls: "cc-research-modal-status", attr: { role: "status" } });
    const retry = root.createEl("button", { text: "Try reading again" });
    retry.hide();
    const list = root.createDiv({ cls: "cc-research-passage-list" });

    const own = root.createDiv({ cls: "cc-research-modal-field" });
    const toggle = own.createEl("button", { text: "Add your own passage" });
    const manual = own.createDiv({ cls: "cc-research-passage-manual is-hidden" });
    const manualText = manual.createEl("textarea", { attr: { "aria-label": "Your passage", rows: "3", placeholder: "Paste the exact passage from the source" } });
    const manualRow = manual.createDiv({ cls: "cc-research-locator-row" });
    const manualKind = manualRow.createEl("select", { attr: { "aria-label": "Where it is: type" } });
    for (const value of LOCATOR_KINDS) manualKind.createEl("option", { text: value, value });
    const manualValue = manualRow.createEl("input", { attr: { "aria-label": "Where it is: value", placeholder: "e.g. 4 or Methods" } });
    const manualTitle = manual.createEl("input", { attr: { "aria-label": "Passage title", placeholder: "Short title" } });
    let titleEdited = false;
    manualTitle.addEventListener("input", () => { titleEdited = true; });
    let manualOpen = false;
    const setManual = (open: boolean): void => { manualOpen = open; manual.toggleClass("is-hidden", !open); };
    toggle.addEventListener("click", () => setManual(!manualOpen));

    const error = root.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const duplicateNotice = root.createEl("p", { cls: "cc-research-duplicate-passage", attr: { role: "status" } });
    const actions = root.createDiv({ cls: "cc-research-modal-actions" });
    const add = actions.createEl("button", { cls: "mod-cta", text: "Add 0 passages" });

    let cards: Card[] = [];
    const manualFilled = (): boolean => manualText.value.trim().length > 0;
    const manualMatchesSelected = (): boolean => manualFilled() && cards.some(({ check, excerpt }) => check.checked && samePassageExcerpt(manualText.value, excerpt));
    const count = (): number => cards.filter(({ check }) => check.checked).length + (manualFilled() ? 1 : 0);
    const refresh = (): void => {
      const total = count();
      const duplicate = manualMatchesSelected();
      duplicateNotice.setText(duplicate ? "Your manual passage matches a selected suggestion. Uncheck that suggestion or change your manual passage before adding." : "");
      add.setText(`Add ${plural(total)}`);
      add.disabled = this.saving || total === 0 || duplicate;
    };
    manualText.addEventListener("input", () => {
      if (!titleEdited) manualTitle.value = manualText.value.trim().split(/\s+/).slice(0, 8).join(" ");
      refresh();
    });
    
    const renderCards = (passages: ProposedPassage[]): void => {
      list.empty();
      cards = passages.map((passage) => {
        const root = list.createDiv({ cls: "cc-research-passage-card" });
        const check = root.createEl("input", { attr: { type: "checkbox", "aria-label": `Add ${passage.title}` } });
        check.checked = true;
        check.addEventListener("change", refresh);
        const title = root.createEl("input", { attr: { "aria-label": "Passage title" } });
        title.value = passage.title;
        root.createEl("blockquote", { cls: "cc-research-evidence-excerpt", text: passage.excerpt });
        const row = root.createDiv({ cls: "cc-research-locator-row" });
        const kind = row.createEl("select", { attr: { "aria-label": "Where it is: type" } });
        for (const value of LOCATOR_KINDS) kind.createEl("option", { text: value, value });
        kind.value = passage.locatorKind;
        const value = row.createEl("input", { attr: { "aria-label": "Where it is: value" } });
        value.value = passage.locatorValue;
        const interpretation = root.createEl("textarea", { attr: { "aria-label": "What this passage shows", rows: "2" } });
        interpretation.value = passage.interpretation ?? "";
        return { source, check, title, excerpt: passage.excerpt, kind, value, interpretation, root };
      });
      refresh();
      this.setSaving(picker, this.saving);
    };

    let readingPending = false;
    const reading = async (): Promise<void> => {
      if (readingPending || this.saving) return;
      readingPending = true;
      retry.hide();
      error.setText("");
      const title = this.deps.sources.find(({ path }) => path === source)?.title ?? "the source";
      refresh();
      status.setText(`Reading ${title}${label ? ` with ${label}` : ""}…`);
      let result: PassageLoad;
      try { result = await this.deps.load(source); } catch (cause) { result = { kind: "failed", reason: sanitizeLoadError(cause) }; }
      readingPending = false;
      if (!this.open_) return;
      if (result.kind === "passages") {
        status.setText("");
        renderCards(result.passages);
        return;
      }
      setManual(true);
      status.setText(result.kind === "no-text" ? "This source has no text to read. Open it, copy the passage, and paste it below."
        : result.kind === "failed" ? "Couldn't read this source automatically. Add a passage yourself below."
        : "No new exact passages were found for this source. Add one yourself below.");
      if (result.kind === "failed") { error.setText(result.reason); retry.show(); retry.disabled = this.saving; }
    };
    retry.addEventListener("click", () => void reading());

    add.addEventListener("click", () => {
      if (this.saving || count() === 0 || manualMatchesSelected()) return;
      void (async () => {
        this.setSaving(picker, true);
        error.setText("");
        const failures: string[] = [];
        let created = 0;
        try {
          for (const card of [...cards]) {
            if (!card.check.checked) continue;
            const value = card.value.value.trim();
            try {
              await this.deps.create({
                source: card.source, title: card.title.value.trim() || card.excerpt.split(/\s+/).slice(0, 8).join(" "), excerpt: card.excerpt,
                ...(value ? { locatorKind: card.kind.value as SourceLocatorKind, locatorValue: value } : {}),
                ...(card.interpretation.value.trim() ? { interpretation: card.interpretation.value.trim() } : {}),
                reviewState: "reviewed", ...(label ? { model: label } : {}),
              });
              created++;
              card.root.remove();
              cards = cards.filter((item) => item !== card);
            } catch (cause) { failures.push(`${card.title.value}: ${sanitizeLoadError(cause)}`); }
          }
          if (manualFilled()) {
            const value = manualValue.value.trim();
            const excerpt = manualText.value.trim();
            try {
              await this.deps.create({
                source, title: manualTitle.value.trim() || excerpt.split(/\s+/).slice(0, 8).join(" "), excerpt,
                ...(value ? { locatorKind: manualKind.value as SourceLocatorKind, locatorValue: value } : {}),
                reviewState: value ? "reviewed" : "proposed",
              });
              created++;
              manualText.value = "";
              manualTitle.value = "";
              manualValue.value = "";
              manualKind.value = LOCATOR_KINDS[0]!;
              titleEdited = false;
            } catch (cause) { failures.push(`Your passage: ${sanitizeLoadError(cause)}`); }
          }
          if (created) await this.deps.changed();
          if (failures.length) { error.setText(failures.join(" ")); return; }
          new Notice(`Added ${plural(created)}.`);
          if (![...this.work.values()].some((work) => work.count() > 0)) this.close();
          else status.setText(`Added ${plural(created)}. Other passages are still available to add.`);
        } catch (cause) { error.setText(sanitizeLoadError(cause)); }
        finally { this.setSaving(picker, false); }
      })();
    });

    void reading();
    return { root, count, refresh };
  }
}
