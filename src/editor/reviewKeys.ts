// Obsidian's keymap handles keydown in the window capture phase, before any editor listener,
// so review keys are claimed through a Scope while the reviewed editor has focus.
import { Scope, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { resolveAll, reviewInline } from "./inlineDiffExtension";
import type { InlineDiffSession } from "./inlineDiffState";

/** Inline review where Mod-Enter accepts every pending hunk and Escape rejects them while the editor has focus. */
export function reviewInlineWithKeys(app: App, view: EditorView, session: InlineDiffSession): Promise<boolean[] | null> {
  const keys = new ReviewKeys(app, view);
  return reviewInline(view, session).finally(() => keys.dispose());
}

export class ReviewKeys {
  private scope: Scope | null = null;
  private readonly onFocusIn = (): void => this.push();
  private readonly onFocusOut = (event: FocusEvent): void => {
    if (!this.view.dom.contains(event.relatedTarget as Node | null)) this.pop();
  };

  constructor(private readonly app: App, private readonly view: EditorView) {
    view.dom.addEventListener("focusin", this.onFocusIn);
    view.dom.addEventListener("focusout", this.onFocusOut);
    if (view.dom.contains(view.dom.ownerDocument.activeElement)) this.push();
  }

  dispose(): void {
    this.view.dom.removeEventListener("focusin", this.onFocusIn);
    this.view.dom.removeEventListener("focusout", this.onFocusOut);
    this.pop();
  }

  private push(): void {
    if (this.scope) return;
    const scope = new Scope(this.app.scope);
    scope.register(["Mod"], "Enter", (evt) => this.resolve(evt, "accepted"));
    scope.register([], "Escape", (evt) => this.resolve(evt, "rejected"));
    this.app.keymap.pushScope(scope);
    this.scope = scope;
  }

  private pop(): void {
    if (!this.scope) return;
    this.app.keymap.popScope(this.scope);
    this.scope = null;
  }

  /** `false` claims the key; `undefined` lets it reach its element (the instruction prompt keeps its own Enter and Escape). */
  private resolve(evt: KeyboardEvent, decision: "accepted" | "rejected"): false | undefined {
    if (evt.isComposing) return undefined;
    const target = evt.target as { closest?: (selector: string) => unknown } | null;
    if (target?.closest?.(".cc-inline-prompt")) return undefined;
    return resolveAll(this.view, decision) ? false : undefined;
  }
}
