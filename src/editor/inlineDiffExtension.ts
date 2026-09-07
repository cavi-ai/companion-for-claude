// CM6 layer for inline edit review. One field owns the session; anchors follow every transaction.

import { EditorState, Prec, StateEffect, StateField, type Extension, type Range, type Transaction, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { wordDiff } from "../edit/wordDiff";
import { decisions, markHunk, mapSession, pendingHunks, planResolve, type InlineChange, type InlineDiffSession } from "./inlineDiffState";

type Decision = "accepted" | "rejected";

export const openInlineDiff = StateEffect.define<InlineDiffSession>();
export const resolveInlineDiff = StateEffect.define<{ index: number; decision: Decision }>();
export const closeInlineDiff = StateEffect.define<null>();

/** A transaction that swaps the entire document is a file switch, not an edit. */
function replacesWholeDoc(tr: Transaction): boolean {
  let whole = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === tr.startState.doc.length) whole = true;
  });
  return whole;
}

export const inlineDiffField = StateField.define<InlineDiffSession | null>({
  create: () => null,
  update(value, tr) {
    let s = value;
    if (s && tr.docChanged) s = replacesWholeDoc(tr) ? null : mapSession(s, (pos, assoc) => tr.changes.mapPos(pos, assoc));
    for (const e of tr.effects) {
      if (e.is(openInlineDiff)) s = e.value;
      else if (e.is(closeInlineDiff)) s = null;
      else if (e.is(resolveInlineDiff) && s) s = markHunk(s, e.value.index, e.value.decision);
    }
    return s;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => (s ? decorate(s) : Decoration.none)),
});

class AddedText extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: AddedText): boolean {
    return other.text === this.text;
  }
  // Widget DOM is created detached with Obsidian's global helpers; CodeMirror mounts it.
  override toDOM(): HTMLElement {
    return createSpan({ cls: "cc-inline-add", text: this.text });
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

class HunkBar extends WidgetType {
  constructor(readonly index: number, readonly showAll: boolean) {
    super();
  }
  override eq(other: HunkBar): boolean {
    return other.index === this.index && other.showAll === this.showAll;
  }
  // Widget DOM is created detached with Obsidian's global helpers; CodeMirror mounts it.
  override toDOM(view: EditorView): HTMLElement {
    const bar = createSpan({ cls: "cc-inline-bar" });
    const button = (label: string, cls: string, onClick: () => void): void => {
      const b = createEl("button", { cls: `cc-inline-btn ${cls}`, text: label });
      // mousedown keeps the editor selection where it is; click would move the caret first.
      b.addEventListener("mousedown", (event) => {
        event.preventDefault();
        onClick();
      });
      bar.appendChild(b);
    };
    button("Accept", "is-accept", () => resolveOne(view, this.index, "accepted"));
    button("Reject", "is-reject", () => resolveOne(view, this.index, "rejected"));
    if (this.showAll) {
      button("Accept all", "is-accept", () => resolveAll(view, "accepted"));
      button("Reject all", "is-reject", () => resolveAll(view, "rejected"));
    }
    return bar;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function decorate(s: InlineDiffSession): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const pending = pendingHunks(s);
  for (const [order, h] of pending.entries()) {
    let pos = h.from;
    for (const span of wordDiff(h.oldText, h.newText)) {
      if (span.kind === "same") {
        pos += span.text.length;
      } else if (span.kind === "del") {
        ranges.push(Decoration.mark({ class: "cc-inline-del" }).range(pos, pos + span.text.length));
        pos += span.text.length;
      } else {
        ranges.push(Decoration.widget({ widget: new AddedText(span.text), side: 1 }).range(pos));
      }
    }
    ranges.push(Decoration.widget({ widget: new HunkBar(h.index, order === 0 && pending.length > 1), side: 2 }).range(h.to));
  }
  return Decoration.set(ranges, true);
}

export function buildResolve(state: EditorState, index: number, decision: Decision): TransactionSpec | null {
  const s = state.field(inlineDiffField, false);
  if (!s) return null;
  const { change, drifted } = planResolve(s, index, decision, state.doc.toString());
  const hunk = s.hunks[index];
  if (!hunk || hunk.status !== "pending") return null;
  return { ...(change ? { changes: change } : {}), effects: resolveInlineDiff.of({ index, decision: drifted ? "rejected" : decision }) };
}

export function buildResolveAll(state: EditorState, decision: Decision): TransactionSpec | null {
  const s = state.field(inlineDiffField, false);
  if (!s) return null;
  const pending = pendingHunks(s);
  if (pending.length === 0) return null;
  const content = state.doc.toString();
  const changes: InlineChange[] = [];
  const effects: StateEffect<{ index: number; decision: Decision }>[] = [];
  for (const h of pending) {
    const { change, drifted } = planResolve(s, h.index, decision, content);
    if (change) changes.push(change);
    effects.push(resolveInlineDiff.of({ index: h.index, decision: drifted ? "rejected" : decision }));
  }
  // Every change is expressed against the starting document; CM6 composes them.
  return { ...(changes.length > 0 ? { changes } : {}), effects };
}

const resolvers = new WeakMap<EditorView, (accepted: boolean[] | null) => void>();

function settle(view: EditorView): void {
  const s = view.state.field(inlineDiffField, false);
  if (!s || pendingHunks(s).length > 0) return;
  const resolve = resolvers.get(view);
  resolvers.delete(view);
  const flags = decisions(s);
  view.dispatch({ effects: closeInlineDiff.of(null) });
  resolve?.(flags.some(Boolean) ? flags : null);
}

export function resolveOne(view: EditorView, index: number, decision: Decision): boolean {
  const spec = buildResolve(view.state, index, decision);
  if (!spec) return false;
  view.dispatch(spec);
  settle(view);
  return true;
}

export function resolveAll(view: EditorView, decision: Decision): boolean {
  const spec = buildResolveAll(view.state, decision);
  if (!spec) return false;
  view.dispatch(spec);
  settle(view);
  return true;
}

/** Open a session and resolve with the accepted flags, or null when nothing was accepted or the review was cancelled. */
export function reviewInline(view: EditorView, session: InlineDiffSession): Promise<boolean[] | null> {
  cancelInline(view);
  return new Promise((resolve) => {
    resolvers.set(view, resolve);
    view.dispatch({ effects: openInlineDiff.of(session) });
  });
}

export function cancelInline(view: EditorView): void {
  const resolve = resolvers.get(view);
  resolvers.delete(view);
  if (view.state.field(inlineDiffField, false)) view.dispatch({ effects: closeInlineDiff.of(null) });
  resolve?.(null);
}

// A session the field dropped on its own (file switch) still owes its caller an answer.
const watcher = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate): void {
      if (u.startState.field(inlineDiffField, false) && !u.state.field(inlineDiffField, false)) {
        const resolve = resolvers.get(u.view);
        if (resolve) {
          resolvers.delete(u.view);
          resolve(null);
        }
      }
    }
  },
);

export const inlineDiffKeymap = [
  { key: "Mod-Enter", run: (view: EditorView) => resolveAll(view, "accepted") },
  { key: "Escape", run: (view: EditorView) => resolveAll(view, "rejected") },
];

export function inlineDiffExtension(): Extension {
  return [inlineDiffField, watcher, Prec.high(keymap.of(inlineDiffKeymap))];
}
