import { FuzzySuggestModal, type FuzzyMatch, type App } from "obsidian";
import type { SessionMeta } from "../memory/sessions";

/** Fuzzy picker over this vault's Claude Code sessions, newest first. */
export class SessionPicker extends FuzzySuggestModal<SessionMeta> {
  constructor(
    app: App,
    private sessions: SessionMeta[],
    private onChoose: (session: SessionMeta) => void,
  ) {
    super(app);
    this.setPlaceholder(
      sessions.length ? "Capture a Claude Code session…" : "No sessions found for this vault",
    );
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "capture" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  override getItems(): SessionMeta[] {
    return this.sessions;
  }

  override getItemText(item: SessionMeta): string {
    return `${item.preview} ${item.gitBranch ?? ""}`;
  }

  override renderSuggestion(match: FuzzyMatch<SessionMeta>, el: HTMLElement): void {
    const s = match.item;
    el.addClass("cc-conv-suggestion");
    el.createDiv({ cls: "cc-conv-title", text: s.preview });
    const when = s.startedAt ? s.startedAt.slice(0, 10) : "";
    const meta = [when, s.gitBranch, s.model].filter(Boolean).join(" · ");
    el.createDiv({ cls: "cc-conv-meta", text: meta || s.id });
  }

  override onChooseItem(item: SessionMeta): void {
    this.onChoose(item);
  }
}
