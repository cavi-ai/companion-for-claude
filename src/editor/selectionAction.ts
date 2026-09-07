// Floating "Rewrite with Claude" over a selection that has held still. Desktop only; wired by main.ts.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";

export interface SelectionActionDeps {
  enabled(): boolean;
  run(view: EditorView): void;
}

const SETTLE_MS = 300;

const setTooltip = StateEffect.define<Tooltip | null>();

const tooltipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    let t = value;
    for (const e of tr.effects) if (e.is(setTooltip)) t = e.value;
    if (t && (tr.docChanged || tr.selection)) t = null;
    return t;
  },
  provide: (f) => showTooltip.from(f),
});

function makeTooltip(view: EditorView, deps: SelectionActionDeps): Tooltip {
  const { from } = view.state.selection.main;
  return {
    pos: from,
    above: true,
    strictSide: true,
    arrow: false,
    // Widget DOM is created detached with Obsidian's global helpers; CodeMirror mounts it.
    create() {
      const dom = createDiv({ cls: "cc-selection-action" });
      const button = createEl("button", { text: "Rewrite with Claude" });
      // mousedown keeps the selection; click would collapse it before run() reads it.
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        view.dispatch({ effects: setTooltip.of(null) });
        deps.run(view);
      });
      dom.appendChild(button);
      return { dom };
    },
  };
}

export function selectionActionExtension(deps: SelectionActionDeps): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: number | null = null;
      constructor(private readonly view: EditorView) {}
      update(u: ViewUpdate): void {
        if (!u.selectionSet && !u.docChanged) return;
        this.clear();
        const { main } = u.state.selection;
        if (main.empty || !deps.enabled()) return;
        this.timer = window.setTimeout(() => {
          this.timer = null;
          if (this.view.state.selection.main.empty) return;
          this.view.dispatch({ effects: setTooltip.of(makeTooltip(this.view, deps)) });
        }, SETTLE_MS);
      }
      destroy(): void {
        this.clear();
      }
      private clear(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
      }
    },
  );
  return [tooltipField, plugin];
}
