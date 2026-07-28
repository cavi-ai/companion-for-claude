import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TurnRenderer, type TurnRendererHost } from "../../src/view/turnRenderer";
import type { TokenUsage } from "../../src/claude/sse";

function fakeEl(): HTMLElement {
  const el = {
    text: "",
    setText(t: string) {
      el.text = t;
    },
    createDiv() {
      return fakeEl();
    },
  };
  return el as unknown as HTMLElement;
}

interface Captured {
  rendered: string[];
  artifactPaints: number;
  scrolls: number;
  cleared: number;
  truncated: number;
  usage: TokenUsage[];
  buffers: string[];
}

function host(): TurnRendererHost & { c: Captured } {
  const c: Captured = { rendered: [], artifactPaints: 0, scrolls: 0, cleared: 0, truncated: 0, usage: [], buffers: [] };
  return {
    c,
    renderMarkdownInto: (_el, md) => {
      c.rendered.push(md);
      return Promise.resolve();
    },
    renderStreamingArtifactInto: () => {
      c.artifactPaints++;
    },
    scrollToBottom: () => {
      c.scrolls++;
    },
    clearThinkingStatus: () => {
      c.cleared++;
    },
    createThinkingPanel: () => fakeEl(),
    annotateTruncated: () => {
      c.truncated++;
    },
    mergeTurnUsage: (u) => c.usage.push(u),
    syncBuffer: (b) => c.buffers.push(b),
  };
}

/** Drive window.requestAnimationFrame manually. */
let rafQueue: Array<() => void>;
function pumpFrames(n = 50): void {
  for (let i = 0; i < n && rafQueue.length > 0; i++) rafQueue.shift()!();
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("window", { requestAnimationFrame: (cb: () => void) => (rafQueue.push(cb), rafQueue.length) });
});

afterEach(() => vi.unstubAllGlobals());

describe("TurnRenderer", () => {
  it("streams text into the buffer, mirrors it, and renders throttled frames", () => {
    const h = host();
    const r = new TurnRenderer(h, fakeEl(), fakeEl(), false);
    r.onText("Hello");
    r.onText(" world");
    expect(r.buffer).toBe("Hello world");
    expect(h.c.buffers.at(-1)).toBe("Hello world");
    expect(h.c.cleared).toBe(1); // thinking status cleared once, on first token
    pumpFrames();
    expect(h.c.rendered.at(-1)).toBe("Hello world");
  });

  it("accumulates thinking into a lazily created panel", () => {
    const h = host();
    const r = new TurnRenderer(h, fakeEl(), fakeEl(), false);
    r.onThinking("step ");
    r.onThinking("two");
    // Panel created on first thinking delta even when wantThinking was false.
    expect(h.c.scrolls).toBeGreaterThan(0);
  });

  it("separates text across tool boundaries with a paragraph break", () => {
    const h = host();
    const r = new TurnRenderer(h, fakeEl(), fakeEl(), false);
    r.onText("first pass");
    r.markToolBoundary();
    r.onText("second pass");
    expect(r.buffer).toBe("first pass\n\nsecond pass");
    // No boundary → no separator.
    r.onText("!");
    expect(r.buffer).toBe("first pass\n\nsecond pass!");
  });

  it("finalize does the authoritative render and stops further flushes", async () => {
    const h = host();
    const r = new TurnRenderer(h, fakeEl(), fakeEl(), false);
    r.onText("partial");
    pumpFrames();
    await r.finalize("complete");
    expect(h.c.rendered.at(-1)).toBe("complete");
    expect(r.buffer).toBe("complete");
    r.onText("late");
    pumpFrames();
    expect(h.c.rendered.at(-1)).not.toBe("completelate");
  });

  it("forwards usage and truncation to the host", () => {
    const h = host();
    const r = new TurnRenderer(h, fakeEl(), fakeEl(), false);
    const usage: TokenUsage = { input_tokens: 10, output_tokens: 5 };
    r.onUsage(usage);
    r.onTruncated();
    expect(h.c.usage).toEqual([usage]);
    expect(h.c.truncated).toBe(1);
  });
});
