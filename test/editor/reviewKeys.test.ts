import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { App, FakeElement } from "obsidian";
import { describe, expect, it } from "vitest";
import { planEdits } from "../../src/edit/diff";
import { cancelInline, inlineDiffField } from "../../src/editor/inlineDiffExtension";
import { createSession } from "../../src/editor/inlineDiffState";
import { reviewInlineWithKeys } from "../../src/editor/reviewKeys";

const DOC = "# Build plan\n\n- [ ] Create the parser\n- [ ] Ship it\n";
const ACCEPTED = DOC.replace("Create the parser", "Create the tokenizer").replace("Ship it", "Ship it to the store");

const session = () =>
  createSession(DOC, planEdits(DOC, [
    { old_str: "Create the parser", new_str: "Create the tokenizer" },
    { old_str: "Ship it", new_str: "Ship it to the store" },
  ]), { path: "Build plan.md" });

type Handler = { modifiers: string[] | null; key: string | null; func: (evt: KeyboardEvent, ctx: unknown) => unknown };

function setup(focused = true) {
  const app = new App();
  const dom = new FakeElement();
  const outside = new FakeElement();
  const doc = { activeElement: focused ? dom : outside };
  (dom as unknown as { ownerDocument: unknown }).ownerDocument = doc;
  const view = {
    state: EditorState.create({ doc: DOC, extensions: [inlineDiffField] }),
    dom,
    dispatch(spec: Parameters<EditorState["update"]>[0]) { view.state = view.state.update(spec).state; },
  };
  const scopes = () => (app.keymap as unknown as { scopes: Array<{ parent: unknown; keys: Handler[] }> }).scopes;
  const press = (key: string, extra: Partial<KeyboardEvent> & { inPrompt?: boolean } = {}) => {
    const handler = scopes().at(-1)?.keys.find((h) => h.key === key);
    if (!handler) throw new Error(`no scope handler for ${key}`);
    const target = { closest: (selector: string) => (extra.inPrompt && selector === ".cc-inline-prompt" ? {} : null) };
    return handler.func({ key, isComposing: false, target, ...extra } as unknown as KeyboardEvent, {});
  };
  return { app, dom, outside, view: view as unknown as EditorView & { state: EditorState }, scopes, press };
}

describe("reviewInlineWithKeys", () => {
  it("claims Mod-Enter through an Obsidian scope while the editor has focus, accepts every hunk, then removes the scope", async () => {
    const { app, view, scopes, press } = setup();
    const review = reviewInlineWithKeys(app, view, session());
    expect(scopes()).toHaveLength(1);
    expect(scopes()[0]!.parent).toBe(app.scope);
    expect(scopes()[0]!.keys.find((h) => h.key === "Enter")!.modifiers).toEqual(["Mod"]);
    expect(press("Enter")).toBe(false);
    expect(view.state.doc.toString()).toBe(ACCEPTED);
    expect(await review).toEqual([true, true]);
    expect(scopes()).toHaveLength(0);
  });

  it("Escape rejects every hunk, leaves the text, and removes the scope", async () => {
    const { app, view, scopes, press } = setup();
    const review = reviewInlineWithKeys(app, view, session());
    expect(press("Escape")).toBe(false);
    expect(view.state.doc.toString()).toBe(DOC);
    expect(await review).toBeNull();
    expect(scopes()).toHaveLength(0);
  });

  it("leaves a key typed in the instruction prompt, or during IME composition, to its element", () => {
    const { app, view, press } = setup();
    void reviewInlineWithKeys(app, view, session());
    expect(press("Escape", { inPrompt: true })).toBeUndefined();
    expect(press("Enter", { isComposing: true })).toBeUndefined();
    expect(view.state.field(inlineDiffField, false)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("holds the scope only while focus is inside the reviewed editor", () => {
    const { app, dom, outside, view, scopes } = setup(false);
    void reviewInlineWithKeys(app, view, session());
    expect(scopes()).toHaveLength(0);
    dom.dispatchEvent({ type: "focusin" });
    expect(scopes()).toHaveLength(1);
    dom.dispatchEvent({ type: "focusin" });
    expect(scopes()).toHaveLength(1);
    dom.dispatchEvent({ type: "focusout", relatedTarget: outside });
    expect(scopes()).toHaveLength(0);
  });

  it("removes the scope and its focus listeners when the review is cancelled", async () => {
    const { app, dom, view, scopes } = setup();
    const review = reviewInlineWithKeys(app, view, session());
    cancelInline(view);
    expect(await review).toBeNull();
    expect(scopes()).toHaveLength(0);
    dom.dispatchEvent({ type: "focusin" });
    expect(scopes()).toHaveLength(0);
  });
});
