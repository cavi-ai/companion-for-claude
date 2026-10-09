import { EditorState, type TransactionSpec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { FakeElement, fakeDocument } from "../fakes/obsidian";
import { inlineDiffExtension } from "../../src/editor/inlineDiffExtension";
import {
  PromptWatcher,
  clearPendingRange,
  escapeInlinePrompt,
  inlinePromptExtension,
  openInlinePrompt,
  pendingRangeField,
  setPendingRange,
  validPendingRange,
  type PendingRange,
} from "../../src/editor/inlinePrompt";

const DOC = "# Plan\n\nFirst line here.\nSecond line here.\n";
const FROM = DOC.indexOf("Second");
const TO = FROM + "Second line".length;

function open(p: Partial<PendingRange> = {}): EditorState {
  const range: PendingRange = { id: 7, mode: "rewrite", from: FROM, to: TO, anchor: FROM, valid: true, ...p };
  const state = EditorState.create({ doc: DOC, extensions: [pendingRangeField] });
  return state.update({ effects: setPendingRange.of(range) }).state;
}

describe("pending range (selection mode)", () => {
  it("an edit before the range shifts it and keeps it valid", () => {
    const s = open().update({ changes: { from: 0, insert: "## " } }).state;
    expect(validPendingRange(s, 7)).toEqual({ from: FROM + 3, to: TO + 3 });
    expect(s.doc.sliceString(FROM + 3, TO + 3)).toBe("Second line");
  });

  it("an edit after the range leaves it in place", () => {
    const s = open().update({ changes: { from: DOC.length, insert: "tail" } }).state;
    expect(validPendingRange(s, 7)).toEqual({ from: FROM, to: TO });
  });

  it("an edit inside the range invalidates it", () => {
    const s = open().update({ changes: { from: FROM + 2, to: FROM + 3, insert: "X" } }).state;
    expect(validPendingRange(s, 7)).toBeNull();
    expect(s.field(pendingRangeField)?.valid).toBe(false);
  });

  it("typing right after the range keeps it", () => {
    const s = open().update({ changes: { from: TO, insert: "!!" } }).state;
    expect(validPendingRange(s, 7)).toEqual({ from: FROM, to: TO });
  });

  it("typing right before the range shifts it and keeps it", () => {
    const s = open().update({ changes: { from: FROM, insert: "ab" } }).state;
    expect(validPendingRange(s, 7)).toEqual({ from: FROM + 2, to: TO + 2 });
    expect(s.doc.sliceString(FROM + 2, TO + 2)).toBe("Second line");
  });

  it("deleting the whole range invalidates it", () => {
    const s = open().update({ changes: { from: FROM, to: TO, insert: "" } }).state;
    expect(validPendingRange(s, 7)).toBeNull();
  });

  it("an edit that overlaps an end of the range invalidates it", () => {
    const s = open().update({ changes: { from: FROM - 3, to: FROM + 1, insert: "" } }).state;
    expect(validPendingRange(s, 7)).toBeNull();
  });

  it("stays invalid after a later unrelated edit", () => {
    let s = open().update({ changes: { from: FROM + 1, insert: "z" } }).state;
    s = s.update({ changes: { from: 0, insert: "a" } }).state;
    expect(validPendingRange(s, 7)).toBeNull();
  });
});

describe("pending range (insert mode)", () => {
  const AT = DOC.indexOf("here.\nSecond");

  it("edits above the cursor shift the insert position", () => {
    const s = open({ mode: "insert", from: AT, to: AT, anchor: DOC.indexOf("First") })
      .update({ changes: { from: 0, to: 2, insert: "Heading: " } }).state;
    expect(validPendingRange(s, 7)).toEqual({ from: AT + 7, to: AT + 7 });
  });

  it("a deletion across the insert position invalidates it", () => {
    const s = open({ mode: "insert", from: AT, to: AT }).update({ changes: { from: AT - 2, to: AT + 2, insert: "" } }).state;
    expect(validPendingRange(s, 7)).toBeNull();
  });
});

describe("pending range lifecycle", () => {
  it("a whole-document replacement (note switch) drops it", () => {
    const s = open().update({ changes: { from: 0, to: DOC.length, insert: "other note" } }).state;
    expect(s.field(pendingRangeField)).toBeNull();
  });

  it("clearing a different prompt's id leaves this one", () => {
    const s = open().update({ effects: clearPendingRange.of(99) }).state;
    expect(validPendingRange(s, 7)).not.toBeNull();
    expect(validPendingRange(s, 99)).toBeNull();
    expect(s.update({ effects: clearPendingRange.of(7) }).state.field(pendingRangeField)).toBeNull();
  });

  it("Escape in the editor falls through to the inline diff when no prompt is open", () => {
    expect(escapeInlinePrompt({} as EditorView)).toBe(false);
  });
});

function fakeView(doc = DOC) {
  const view = {
    state: EditorState.create({ doc, extensions: [pendingRangeField] }),
    dispatch: (spec: TransactionSpec) => {
      view.state = view.state.update(spec).state;
    },
    focus: vi.fn(),
  };
  return view;
}

function openOver(view: ReturnType<typeof fakeView>, mode: "rewrite" | "insert" = "rewrite") {
  const handle = openInlinePrompt(view as unknown as EditorView, { mode, from: FROM, to: mode === "insert" ? FROM : TO, presets: [{ label: "Shorter", instruction: "Make it shorter" }] });
  const dom = (handle as unknown as { dom: FakeElement }).dom;
  return { handle, dom, input: dom.children[0]! };
}

function press(dom: FakeElement, key: string, extra: Record<string, unknown> = {}) {
  const event = { type: "keydown", key, shiftKey: false, isComposing: false, keyCode: 0, stopPropagation: vi.fn(), preventDefault: vi.fn(), ...extra };
  dom.dispatchEvent(event);
  return event;
}

function submit(p: ReturnType<typeof openOver>, text = "tighten") {
  p.input.value = text;
  p.input.dispatchEvent({ type: "input" });
  return press(p.dom, "Enter");
}

describe("prompt controller", () => {
  it("close() after settle() leaves the request running", async () => {
    const p = openOver(fakeView());
    submit(p);
    expect(await p.handle.instruction).toBe("tighten");
    p.handle.settle();
    p.handle.close();
    expect(p.handle.signal.aborted).toBe(false);
    expect(p.handle.cancelled).toBe(false);
  });

  it("Esc while running aborts and marks the prompt cancelled", async () => {
    const p = openOver(fakeView());
    submit(p);
    await p.handle.instruction;
    press(p.dom, "Escape");
    expect(p.handle.signal.aborted).toBe(true);
    expect(p.handle.cancelled).toBe(true);
  });

  it("Enter confirming an IME composition neither submits nor is claimed", async () => {
    const p = openOver(fakeView());
    p.input.value = "かな";
    p.input.dispatchEvent({ type: "input" });
    const event = press(p.dom, "Enter", { isComposing: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    p.handle.close();
    expect(await p.handle.instruction).toBeNull();
  });

  it("close() returns focus to the editor only from inside the prompt or the body", () => {
    const fromPrompt = fakeView();
    const a = openOver(fromPrompt);
    a.input.focus();
    a.handle.close();
    expect(fromPrompt.focus).toHaveBeenCalledTimes(1);

    const fromBody = fakeView();
    const b = openOver(fromBody);
    fakeDocument.activeElement = fakeDocument.body;
    b.handle.close();
    expect(fromBody.focus).toHaveBeenCalledTimes(1);

    const elsewhere = fakeView();
    const c = openOver(elsewhere);
    fakeDocument.activeElement = new FakeElement("input");
    c.handle.close();
    expect(elsewhere.focus).not.toHaveBeenCalled();
  });

  it("teardown before the reply aborts and marks the prompt cancelled", async () => {
    const p = openOver(fakeView());
    submit(p);
    await p.handle.instruction;
    p.handle.close();
    expect(p.handle.signal.aborted).toBe(true);
    expect(p.handle.cancelled).toBe(true);
  });
});

describe("prompt controller wiring", () => {
  it("a claimed key is stopped and prevented; an unclaimed key passes through", () => {
    const p = openOver(fakeView());
    const tab = press(p.dom, "Tab");
    expect(tab.stopPropagation).toHaveBeenCalledTimes(1);
    expect(tab.preventDefault).toHaveBeenCalledTimes(1);
    const letter = press(p.dom, "a");
    expect(letter.stopPropagation).not.toHaveBeenCalled();
    expect(letter.preventDefault).not.toHaveBeenCalled();
    p.handle.close();
  });

  it("Esc in the prompt closes it and returns focus to the editor", async () => {
    const view = fakeView();
    const p = openOver(view);
    p.input.focus();
    const esc = press(p.dom, "Escape");
    expect(esc.preventDefault).toHaveBeenCalledTimes(1);
    expect(await p.handle.instruction).toBeNull();
    expect(view.state.field(pendingRangeField)).toBeNull();
    expect(view.focus).toHaveBeenCalledTimes(1);
  });

  it("the inline diff claims no keymap Escape, so the prompt's Escape is the only one", () => {
    const state = EditorState.create({ extensions: [inlineDiffExtension(), inlinePromptExtension()] });
    const escapes = state.facet(keymap).flatMap((m) => m.filter((b) => b.key === "Escape"));
    expect(escapes.map((b) => b.run)).toEqual([escapeInlinePrompt]);
  });

  it("view teardown (or plugin unload) aborts a running prompt and answers its caller", async () => {
    const view = fakeView();
    const p = openOver(view);
    submit(p);
    expect(await p.handle.instruction).toBe("tighten");
    new PromptWatcher(view as unknown as EditorView).destroy();
    expect(p.handle.signal.aborted).toBe(true);
    expect(p.handle.cancelled).toBe(true);
    expect(p.handle.range()).toBeNull();
  });

  it("a newer prompt in the same view tears down the older one", async () => {
    const view = fakeView();
    const first = openOver(view);
    const second = openOver(view);
    expect(await first.handle.instruction).toBeNull();
    expect(second.handle.range()).toEqual({ from: FROM, to: TO });
    second.handle.close();
  });
});

describe("pending range (insert mode) typing at the cursor", () => {
  it("text typed at the insert position lands after it", () => {
    const AT = DOC.indexOf("Second");
    const s = open({ mode: "insert", from: AT, to: AT }).update({ changes: { from: AT, insert: "zz" } }).state;
    expect(validPendingRange(s, 7)).toEqual({ from: AT, to: AT });
  });
});
