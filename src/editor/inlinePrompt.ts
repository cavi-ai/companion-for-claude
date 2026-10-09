// CM6 inline instruction prompt: a block widget above the target line plus the pending target range.

import { MapMode, Prec, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import {
  RUNNING_LABEL,
  choosePreset,
  initialPrompt,
  placeholderFor,
  pressKey,
  promptKey,
  remember,
  typed,
  type PromptMode,
  type PromptState,
} from "./inlinePromptState";

export interface PendingRange {
  id: number;
  mode: PromptMode;
  from: number;
  to: number;
  /** Start of the line the widget sits above. */
  anchor: number;
  valid: boolean;
}

export const setPendingRange = StateEffect.define<PendingRange>();
export const clearPendingRange = StateEffect.define<number>();

function replacesWholeDoc(tr: Transaction): boolean {
  let whole = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === tr.startState.doc.length) whole = true;
  });
  return whole;
}

export function mapPendingRange(p: PendingRange, changes: ChangeDesc): PendingRange {
  const anchor = changes.mapPos(p.anchor, -1);
  if (p.mode === "insert") {
    const at = changes.mapPos(p.from, -1, MapMode.TrackDel);
    const pos = at ?? changes.mapPos(p.from, -1);
    return { ...p, anchor, from: pos, to: pos, valid: p.valid && at !== null };
  }
  let inside = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA < p.to && toA > p.from) inside = true;
  });
  const from = changes.mapPos(p.from, 1);
  const to = changes.mapPos(p.to, -1);
  return { ...p, anchor, from, to, valid: p.valid && !inside && to > from };
}

export const pendingRangeField = StateField.define<PendingRange | null>({
  create: () => null,
  update(value, tr) {
    let p = value;
    if (p && tr.docChanged) p = replacesWholeDoc(tr) ? null : mapPendingRange(p, tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPendingRange)) p = e.value;
      else if (e.is(clearPendingRange) && p?.id === e.value) p = null;
    }
    return p;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (p) =>
      p ? Decoration.set([Decoration.widget({ widget: new PromptWidget(p.id), block: true, side: -1 }).range(p.anchor)]) : Decoration.none,
    ),
});

/** The pending target when it is still intact, else null. */
export function validPendingRange(state: EditorState, id: number): { from: number; to: number } | null {
  const p = state.field(pendingRangeField, false);
  if (!p || p.id !== id || !p.valid) return null;
  return { from: p.from, to: p.to };
}

export interface InlinePromptOptions {
  mode: PromptMode;
  from: number;
  to: number;
  presets: readonly { label: string; instruction: string }[];
}

export interface InlinePromptHandle {
  /** The submitted instruction, or null when the prompt closed without one. */
  readonly instruction: Promise<string | null>;
  /** Aborted by Esc while running, a note switch, view teardown, or a newer prompt — never after settle(). */
  readonly signal: AbortSignal;
  /** True when Esc or a teardown aborted the request before settle(). */
  readonly cancelled: boolean;
  /** The reply arrived: later close()/dispose() never abort. */
  settle(): void;
  /** The target range if no edit touched it while the request ran. */
  range(): { from: number; to: number } | null;
  /** Remove the widget; focus returns to the editor only from inside the prompt or the body. */
  close(): void;
}

let nextId = 1;
let history: string[] = [];
const byId = new Map<number, PromptController>();
const byView = new WeakMap<EditorView, PromptController>();

class PromptController implements InlinePromptHandle {
  readonly id = nextId++;
  readonly dom: HTMLElement;
  readonly instruction: Promise<string | null>;
  private readonly abort = new AbortController();
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly chips: HTMLButtonElement[] = [];
  private readonly presets: readonly string[];
  private state: PromptState;
  private resolveInstruction: (value: string | null) => void = () => {};
  private disposed = false;
  private settled = false;
  private wasCancelled = false;

  constructor(private readonly view: EditorView, opts: InlinePromptOptions) {
    this.state = initialPrompt(opts.mode);
    this.presets = opts.presets.map((p) => p.instruction);
    this.instruction = new Promise((resolve) => {
      this.resolveInstruction = resolve;
    });
    this.dom = createDiv({ cls: "cc-inline-prompt" });
    this.input = createEl("input", { cls: "cc-inline-prompt-input", type: "text", attr: { placeholder: placeholderFor(opts.mode), "aria-label": placeholderFor(opts.mode) } });
    this.dom.appendChild(this.input);
    const row = createDiv({ cls: "cc-inline-prompt-presets" });
    opts.presets.forEach((preset, index) => {
      const chip = createEl("button", { cls: "cc-inline-prompt-chip", text: preset.label });
      chip.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.apply(choosePreset(this.state, index, this.presets));
      });
      this.chips.push(chip);
      row.appendChild(chip);
    });
    this.dom.appendChild(row);
    this.status = createDiv({ cls: "cc-inline-prompt-status", text: RUNNING_LABEL });
    this.status.hide();
    this.dom.appendChild(this.status);
    this.input.addEventListener("input", () => {
      this.state = typed(this.state, this.input.value);
    });
    this.dom.addEventListener("keydown", (event) => this.onKey(event));
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get cancelled(): boolean {
    return this.wasCancelled;
  }

  settle(): void {
    this.settled = true;
  }

  private cancel(): void {
    if (this.settled || this.wasCancelled || this.state.phase !== "running") return;
    this.wasCancelled = true;
    this.abort.abort();
  }

  range(): { from: number; to: number } | null {
    return this.disposed ? null : validPendingRange(this.view.state, this.id);
  }

  focus(): void {
    this.input.focus();
  }

  /** Esc from the editor while the prompt is open: same as Esc in the prompt. */
  escape(): boolean {
    if (this.disposed) return false;
    this.cancel();
    this.close();
    return true;
  }

  close(): void {
    if (this.disposed) return;
    const doc = this.dom.ownerDocument;
    const active = doc.activeElement;
    const refocus = !active || active === doc.body || this.dom.contains(active);
    this.dispose();
    if (this.view.state.field(pendingRangeField, false)?.id === this.id) this.view.dispatch({ effects: clearPendingRange.of(this.id) });
    if (refocus) this.view.focus();
  }

  /** Teardown without touching the view (note switch, view destroyed, superseded). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    byId.delete(this.id);
    if (byView.get(this.view) === this) byView.delete(this.view);
    this.resolveInstruction(null);
  }

  private onKey(event: KeyboardEvent): void {
    const key = promptKey(event);
    if (!key) return;
    // Claimed keys must not reach the editor or the inline diff keymap.
    event.stopPropagation();
    event.preventDefault();
    const { state, effect } = pressKey(this.state, key, { history, presets: this.presets });
    this.apply(state);
    if (effect.kind === "close") this.close();
    else if (effect.kind === "abort") this.escape();
    else if (effect.kind === "submit") {
      history = remember(history, effect.instruction);
      this.resolveInstruction(effect.instruction);
    }
  }

  private apply(next: PromptState): void {
    this.state = next;
    if (this.input.value !== next.input) this.input.value = next.input;
    const running = next.phase === "running";
    this.input.readOnly = running;
    this.status.toggle(running);
    for (const chip of this.chips) chip.toggle(!running);
    const target = next.focus >= 0 ? this.chips[next.focus] : this.input;
    if (target && target.ownerDocument.activeElement !== target) target.focus();
  }
}

class PromptWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  override eq(other: PromptWidget): boolean {
    return other.id === this.id;
  }
  override toDOM(): HTMLElement {
    return byId.get(this.id)?.dom ?? createDiv();
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Open the prompt over [from, to]; a prompt already open in this view is torn down first. */
export function openInlinePrompt(view: EditorView, opts: InlinePromptOptions): InlinePromptHandle {
  byView.get(view)?.close();
  const controller = new PromptController(view, opts);
  byId.set(controller.id, controller);
  byView.set(view, controller);
  const anchor = view.state.doc.lineAt(opts.from).from;
  view.dispatch({ effects: setPendingRange.of({ id: controller.id, mode: opts.mode, from: opts.from, to: opts.to, anchor, valid: true }) });
  window.setTimeout(() => controller.focus(), 0);
  return controller;
}

export function escapeInlinePrompt(view: EditorView): boolean {
  return byView.get(view)?.escape() ?? false;
}

export class PromptWatcher {
  constructor(private readonly view: EditorView) {}
  update(u: ViewUpdate): void {
    const before = u.startState.field(pendingRangeField, false);
    if (before && !u.state.field(pendingRangeField, false)) byId.get(before.id)?.dispose();
  }
  destroy(): void {
    byView.get(this.view)?.dispose();
  }
}

const watcher = ViewPlugin.fromClass(PromptWatcher);

export function inlinePromptExtension(): Extension {
  return [pendingRangeField, watcher, Prec.highest(keymap.of([{ key: "Escape", run: escapeInlinePrompt }]))];
}
