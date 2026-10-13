import { MarkdownRenderer, type App, type Component } from "obsidian";
import { splitStreamingArtifact } from "../streamRender";

/** Renders markdown into an element; a render that a newer one superseded never touches the element. */
export class VersionedMarkdownRenderer {
  private versions = new WeakMap<HTMLElement, number>();

  constructor(private app: App, private component: Component) {}

  async renderInto(el: HTMLElement, markdown: string): Promise<void> {
    const version = this.bump(el);
    const rendered = createDiv();
    await MarkdownRenderer.render(this.app, markdown, rendered, this.app.workspace.getActiveFile()?.path ?? "", this.component);
    if (this.versions.get(el) !== version) return;
    el.replaceChildren(...Array.from(rendered.childNodes));
  }

  /**
   * While a `claude-html` artifact is streaming, don't dump its raw HTML source
   * into the bubble. Render whatever prose preceded the fence as markdown and put
   * a compact "building" chip in the artifact's place; the final `renderInto`
   * on `onDone` swaps in the sandboxed iframe. Painted once per artifact (flush
   * guards re-entry) so the chip and lead-in prose stay stable, not re-rendered
   * every frame.
   */
  renderStreamingArtifactInto(el: HTMLElement, buffer: string): void {
    const { before } = splitStreamingArtifact(buffer);
    const version = this.bump(el);
    const rendered = createDiv();
    const paint = (): void => {
      if (this.versions.get(el) !== version) return;
      const chip = rendered.createDiv({ cls: "cc-artifact-building" });
      chip.createSpan({ cls: "cc-artifact-building-label", text: "Building artifact…" });
      el.replaceChildren(...Array.from(rendered.childNodes));
    };
    if (before.trim().length > 0) {
      void MarkdownRenderer.render(this.app, before, rendered, this.app.workspace.getActiveFile()?.path ?? "", this.component).then(paint);
    } else {
      paint();
    }
  }

  private bump(el: HTMLElement): number {
    const version = (this.versions.get(el) ?? 0) + 1;
    this.versions.set(el, version);
    return version;
  }
}
