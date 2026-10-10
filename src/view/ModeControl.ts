import { setIcon } from "obsidian";
import type { ChatMode, ChatModeState } from "./chat/chatMode";

const SEGMENTS: Array<{ mode: ChatMode; icon: string; label: string; title: string }> = [
  { mode: "ask", icon: "message-circle", label: "Ask", title: "Ask — chat only, no vault changes" },
  { mode: "plan", icon: "map", label: "Plan", title: "Plan — read-only exploration, proposes a plan" },
  { mode: "act", icon: "pencil", label: "Act", title: "Act — creates and edits notes, each change asks first" },
];

/** The Ask / Plan / Act switch for one chat: shows its mode, changes it, and hides while the backend can't run tools. */
export class ModeControl {
  readonly el: HTMLElement;
  private buttons = new Map<ChatMode, HTMLButtonElement>();
  private readonly unsubscribe: () => void;

  constructor(parent: HTMLElement, private readonly state: ChatModeState) {
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
      const i = order.indexOf(this.state.mode);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); this.choose(order[(i + 1) % order.length]!); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); this.choose(order[(i + order.length - 1) % order.length]!); }
    });
    this.unsubscribe = state.onChange(() => this.render());
    this.render();
  }

  /** Stop following the chat's mode; call before replacing this switch. */
  dispose(): void {
    this.unsubscribe();
  }

  private render(): void {
    const mode = this.state.mode;
    this.el.toggleClass("is-hidden", !this.state.capable);
    for (const [m, b] of this.buttons) {
      b.setAttr("aria-checked", String(m === mode));
      b.toggleClass("is-active", m === mode);
      b.setAttr("tabindex", m === mode ? "0" : "-1");
    }
  }

  private choose(mode: ChatMode): void {
    if (mode === this.state.mode) return;
    this.buttons.get(mode)?.focus();
    void this.state.change(mode);
  }
}
