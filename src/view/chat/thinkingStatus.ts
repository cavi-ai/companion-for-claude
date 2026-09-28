// The pre-token "working" indicator: a breathing smiley with a whimsical word
// cycling beside it. DOM + one timer; the view owns lifecycle via clear().

import { setIcon } from "obsidian";

/** Playful "Claudian" gerunds shown while Claude works, before text arrives. */
const CLAUDIAN = [
  "Manifesting", "Synthesizing", "Philosophising", "Pondering",
  "Actualizing", "Synergizing", "Ruminating", "Clauding",
];

export class ThinkingStatus {
  private timer: number | null = null;
  private seq = 0;

  /**
   * Show the indicator in `body` until the first token lands. The smiley is
   * fixed-position so the word's changing length never shifts it; the swap
   * lands on the CSS fade trough (3000ms = the 20-bpm word-fade period).
   */
  start(body: HTMLElement): void {
    const status = body.createSpan({ cls: "cc-thinking-status" });
    setIcon(status.createSpan({ cls: "cc-thinking-dot" }), "smile");
    const word = status.createSpan({ cls: "cc-thinking-word" });
    let i = this.seq++;
    const tick = () => {
      word.setText(`${CLAUDIAN[i % CLAUDIAN.length]}…`);
      i++;
    };
    tick();
    this.clear();
    this.timer = window.setInterval(tick, 3000);
  }

  clear(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
