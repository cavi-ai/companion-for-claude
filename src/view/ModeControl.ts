import { setIcon } from "obsidian";

export type ChatMode = "ask" | "plan" | "act";
export interface ModeControlOptions { initial: ChatMode; onChange(mode: ChatMode): void | Promise<void>; }

const SEGMENTS: Array<{ mode: ChatMode; icon: string; label: string; title: string }> = [
  { mode: "ask", icon: "message-circle", label: "Ask", title: "Ask — chat only, no vault changes" },
  { mode: "plan", icon: "map", label: "Plan", title: "Plan — read-only exploration, proposes a plan" },
  { mode: "act", icon: "pencil", label: "Act", title: "Act — creates and edits notes, each change asks first" },
];

export class ModeControl {
  readonly el: HTMLElement;
  private buttons = new Map<ChatMode, HTMLButtonElement>();
  private mode: ChatMode;

  constructor(parent: HTMLElement, private opts: ModeControlOptions) {
    this.mode = opts.initial;
    this.el = parent.createDiv({ cls: "cc-mode-control", attr: { role: "radiogroup", "aria-label": "Chat mode" } });
    for (const seg of SEGMENTS) {
      const b = this.el.createEl("button", { cls: "cc-mode-segment", attr: { role: "radio", "aria-label": seg.title, title: seg.title } });
      const icon = b.createSpan({ cls: "cc-mode-segment-icon" });
      setIcon(icon, seg.icon);
      b.createSpan({ cls: "cc-mode-segment-label", text: seg.label });
      b.addEventListener("click", () => this.choose(seg.mode));
      this.buttons.set(seg.mode, b);
    }
    this.el.addEventListener("keydown", (e: KeyboardEvent) => {
      const order = SEGMENTS.map((s) => s.mode);
      const i = order.indexOf(this.mode);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); this.choose(order[(i + 1) % order.length]!); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); this.choose(order[(i + order.length - 1) % order.length]!); }
    });
    this.set(this.mode);
  }

  set(mode: ChatMode): void {
    this.mode = mode;
    for (const [m, b] of this.buttons) {
      b.setAttr("aria-checked", String(m === mode));
      b.toggleClass("is-active", m === mode);
      b.setAttr("tabindex", m === mode ? "0" : "-1");
    }
  }

  setVisible(visible: boolean): void { this.el.toggleClass("is-hidden", !visible); }

  private choose(mode: ChatMode): void {
    if (mode === this.mode) return;
    this.set(mode);
    this.buttons.get(mode)?.focus();
    void this.opts.onChange(mode);
  }
}
