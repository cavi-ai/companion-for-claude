// The shared streaming-render pipeline behind a chat turn: throttled markdown
// re-render while tokens arrive, the thinking panel, usage/truncated hooks,
// and the authoritative final render. streamTurn and agentTurn ran identical
// copies of this (the code admitted it — "same pattern as streamTurn"); both
// now drive one TurnRenderer.

import { shouldRenderMarkdownDuringStream } from "./streamRender";
import type { TokenUsage } from "../claude/sse";

export interface TurnRendererHost {
  renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void>;
  renderStreamingArtifactInto(el: HTMLElement, buffer: string): void;
  scrollToBottom(): void;
  clearThinkingStatus(): void;
  createThinkingPanel(bubble: HTMLElement): HTMLElement;
  annotateTruncated(bubble: HTMLElement): void;
  /** Fold a usage report into the turn totals (ChatView owns the numbers). */
  mergeTurnUsage(usage: TokenUsage): void;
  /** Mirror the in-flight buffer for abort/interrupt recovery (_lastBuffer). */
  syncBuffer(buffer: string): void;
}

/**
 * Throttle the (expensive) full markdown re-render during streaming. Rendering
 * every animation frame swaps the whole subtree via replaceChildren ~60×/s,
 * which reads as flicker. ~100ms keeps it lively without churn; finalize()
 * always does the final authoritative render, and skipped frames just keep the
 * last paint (the next delta reschedules a flush, so content never stalls).
 */
const MD_THROTTLE_MS = 100;

export class TurnRenderer {
  /** The streamed answer so far (agent turns join iterations into it). */
  buffer = "";
  private thinkBuf = "";
  private thinkingBody: HTMLElement | null = null;
  private scheduled = false;
  private finalizing = false;
  /** -Infinity so the first flush paints immediately; only later frames throttle. */
  private lastMd = -Infinity;
  private artifactPainted = false;
  /** Agent turns: separate text across tool-call iterations with a paragraph break. */
  private needSeparator = false;

  constructor(
    private host: TurnRendererHost,
    private bubble: HTMLElement,
    private body: HTMLElement,
    wantThinking: boolean,
  ) {
    this.thinkingBody = wantThinking ? host.createThinkingPanel(bubble) : null;
  }

  onText(delta: string): void {
    if (this.buffer === "") this.host.clearThinkingStatus(); // first token landed
    if (this.needSeparator && this.buffer.length > 0) this.buffer += "\n\n";
    this.needSeparator = false;
    this.buffer += delta;
    this.host.syncBuffer(this.buffer);
    if (!this.scheduled) {
      this.scheduled = true;
      window.requestAnimationFrame(() => this.flush());
    }
  }

  onThinking(delta: string): void {
    if (!this.thinkingBody) this.thinkingBody = this.host.createThinkingPanel(this.bubble);
    this.thinkBuf += delta;
    this.thinkingBody.setText(this.thinkBuf);
    this.host.scrollToBottom();
  }

  onUsage(usage: TokenUsage): void {
    this.host.mergeTurnUsage(usage);
  }

  onTruncated(): void {
    this.host.annotateTruncated(this.bubble);
  }

  /** Next streamed text starts a new paragraph (agent tool-iteration boundary). */
  markToolBoundary(): void {
    this.needSeparator = true;
  }

  private flush(): void {
    this.scheduled = false;
    if (this.finalizing) return;
    if (shouldRenderMarkdownDuringStream(this.buffer)) {
      this.artifactPainted = false;
      const now = performance.now();
      if (now - this.lastMd < MD_THROTTLE_MS) return; // skip; next delta reschedules
      this.lastMd = now;
      void this.host.renderMarkdownInto(this.body, this.buffer);
    } else if (!this.artifactPainted) {
      this.artifactPainted = true; // paint the "building" chip once; the fence is streaming
      this.host.renderStreamingArtifactInto(this.body, this.buffer);
    }
    this.host.scrollToBottom();
  }

  /** The authoritative end-of-turn render. `text` replaces the buffer when given. */
  async finalize(text?: string): Promise<void> {
    this.finalizing = true;
    if (text !== undefined) this.buffer = text;
    this.host.syncBuffer(this.buffer);
    await this.host.renderMarkdownInto(this.body, this.buffer);
  }
}
