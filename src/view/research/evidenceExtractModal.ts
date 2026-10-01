import { Modal, Notice, type App } from "obsidian";
import type { ProposedPassage } from "../../research/evidenceExtraction";
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

const plural = (count: number): string => `${count} ${count === 1 ? "passage" : "passages"}`;

export class EvidenceExtractModal extends Modal {
  private run = 0;
  private open_ = true;
  constructor(app: App, private readonly deps: EvidenceExtractDeps) { super(app); }

  override onClose(): void { this.open_ = false; }

  override onOpen(): void {
    const { sources, label } = this.deps;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Pull passages from a source" });
    const sourceField = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    sourceField.createEl("label", { text: "Source" });
    const picker = sourceField.createEl("select", { attr: { "aria-label": "Source" } });
    for (const source of sources) picker.createEl("option", { text: source.title, value: source.path });
    picker.value = this.deps.initialSource;
    const status = this.contentEl.createEl("p", { cls: "cc-research-modal-status", attr: { role: "status" } });
    const list = this.contentEl.createDiv({ cls: "cc-research-passage-list" });

    const own = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
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

    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const actions = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
    const add = actions.createEl("button", { cls: "mod-cta", text: "Add 0 passages" });

    let cards: Card[] = [];
    const manualFilled = (): boolean => manualText.value.trim().length > 0;
    const count = (): number => cards.filter(({ check }) => check.checked).length + (manualFilled() ? 1 : 0);
    const refresh = (): void => {
      const total = count();
      add.setText(`Add ${plural(total)}`);
      add.disabled = total === 0;
    };
    manualText.addEventListener("input", () => {
      if (!titleEdited) manualTitle.value = manualText.value.trim().split(/\s+/).slice(0, 8).join(" ");
      refresh();
    });
    
    const renderCards = (source: string, passages: ProposedPassage[]): void => {
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
    };

    const reading = async (): Promise<void> => {
      const mine = ++this.run;
      const source = picker.value;
      const title = sources.find(({ path }) => path === source)?.title ?? "the source";
      list.empty();
      cards = [];
      error.setText("");
      refresh();
      status.setText(`Reading ${title}${label ? ` with ${label}` : ""}…`);
      let result: PassageLoad;
      try { result = await this.deps.load(source); } catch (cause) { result = { kind: "failed", reason: sanitizeLoadError(cause) }; }
      if (mine !== this.run || !this.open_) return;
      if (result.kind === "passages") {
        status.setText("");
        renderCards(source, result.passages);
        return;
      }
      setManual(true);
      status.setText(result.kind === "no-text" ? "This source has no text to read. Open it, copy the passage, and paste it below."
        : result.kind === "failed" ? "Couldn't read this source automatically. Add a passage yourself below."
        : "Claude didn't find exact passages for your question in this source. Add one yourself below.");
      if (result.kind === "failed") error.setText(result.reason);
    };
    picker.addEventListener("change", () => void reading());

    add.addEventListener("click", () => {
      void (async () => {
        add.disabled = true;
        error.setText("");
        const failures: string[] = [];
        let created = 0;
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
              source: picker.value, title: manualTitle.value.trim() || excerpt.split(/\s+/).slice(0, 8).join(" "), excerpt,
              ...(value ? { locatorKind: manualKind.value as SourceLocatorKind, locatorValue: value } : {}),
              reviewState: value ? "reviewed" : "proposed",
            });
            created++;
            manualText.value = "";
          } catch (cause) { failures.push(`Your passage: ${sanitizeLoadError(cause)}`); }
        }
        if (created) await this.deps.changed();
        if (failures.length) { error.setText(failures.join(" ")); refresh(); return; }
        new Notice(`Added ${plural(created)}.`);
        this.close();
      })();
    });

    void reading();
  }
}
