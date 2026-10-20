import { type App, type EventRef, Notice, type TAbstractFile, TFile } from "obsidian";
import { checkCitations, currentCitationTargets, extractCitations, resolveCitationPath, type CheckedCitation, type CitationTarget } from "../../chat/provenance";

const PROVENANCE_ITEMS = 12;
export interface ProvenanceFooter { refresh(changed?: TAbstractFile): void; targets(): CitationTarget[]; dispose(): void }

/** Own citation listeners for exactly the bubbles displayed by one transcript. */
export class ProvenanceFooters {
  private readonly handles = new Map<HTMLElement, ProvenanceFooter>();
  constructor(private app: App, private container: () => HTMLElement) {}

  watch(register: (ref: EventRef) => void): void {
    const refresh = (file: TAbstractFile) => {
      this.prune();
      this.handles.forEach(handle => handle.refresh(file));
    };
    register(this.app.vault.on("rename", refresh));
    register(this.app.vault.on("delete", refresh));
    register(this.app.vault.on("modify", refresh));
  }

  render(bubble: HTMLElement, full: string, targets?: CitationTarget[]): void {
    this.prune();
    this.handles.get(bubble)?.dispose();
    this.handles.delete(bubble);
    const handle = renderProvenance(this.app, bubble, full, targets);
    if (handle) this.handles.set(bubble, handle);
  }

  clear(): void {
    this.handles.forEach(handle => handle.dispose());
    this.handles.clear();
  }

  targets(bubble: HTMLElement): CitationTarget[] {
    return this.handles.get(bubble)?.targets() ?? [];
  }

  private prune(): void {
    for (const [bubble, handle] of this.handles) {
      if (this.container().contains(bubble)) continue;
      handle.dispose();
      this.handles.delete(bubble);
    }
  }
}

/** Source objects follow native moves; saved targets preserve navigation when a chat reopens. */
export function renderProvenance(app: App, bubble: HTMLElement, full: string, targets?: CitationTarget[]): ProvenanceFooter | undefined {
  const citations = extractCitations(full);
  if (!citations.length) return;
  const saved = currentCitationTargets(targets);
  const paths = app.vault.getFiles().map(file => file.path);
  const bindings = citations.map(citation => {
    const target = saved?.find(item => item.linkpath === citation.linkpath && item.heading === citation.heading);
    const path = target ? target.path : resolveCitationPath(citation.linkpath, paths).path;
    const file = path ? app.vault.getAbstractFileByPath(path) : null;
    return { citation, file: file instanceof TFile ? file : null };
  });
  const footer = bubble.createDiv({ cls: "cc-provenance", attr: { "aria-live": "polite" } });
  let generation = 0;
  let disposed = false;
  const currentFile = (index: number): TFile | null => {
    const file = bindings[index]?.file;
    return file && app.vault.getAbstractFileByPath(file.path) === file ? file : null;
  };
  const check = () => checkCitations(citations, {
    resolve: linkpath => currentFile(bindings.findIndex(binding => binding.citation.linkpath === linkpath))?.path ?? null,
    ambiguous: linkpath => resolveCitationPath(linkpath, paths).ambiguous,
    read: async path => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? app.vault.cachedRead(file) : "";
    },
  });
  const refresh = (changed?: TAbstractFile): void => {
    if (disposed || (changed && bindings.every(binding => binding.file && binding.file !== changed && !binding.file.path.startsWith(`${changed.path}/`)))) return;
    const version = ++generation;
    void check().then(checked => {
      if (!disposed && version === generation) fillProvenance(footer, checked, open);
    }).catch(() => {
      if (!disposed && version === generation) footer.setText("Couldn't check cited notes. Try opening the source again.");
    });
  };
  const open = async (index: number, newLeaf: boolean): Promise<void> => {
    try {
      const checked = (await check())[index];
      if (disposed) return;
      const file = currentFile(index);
      if (!file || !checked) {
        new Notice(checked?.status === "ambiguous" ? "Several notes share this name. The citation needs the note's folder path." : "Cited note is no longer in the vault. No note was created.");
        refresh();
        return;
      }
      // Opening a TFile cannot create a replacement at a stale link path.
      await app.workspace.getLeaf(newLeaf).openFile(file, checked.status === "found" && checked.heading ? { eState: { subpath: `#${checked.heading}` } } : undefined);
      if (checked.status === "no-section") new Notice("Cited section was not found. Opened the source note instead.");
      refresh();
    } catch (error) {
      new Notice(`Couldn't open the cited note: ${error instanceof Error ? error.message : String(error)}`);
      refresh();
    }
  };
  // Capture before Obsidian's markdown link handler, which can create missing notes.
  const onClick = (event: MouseEvent): void => {
    const link = (event.target as HTMLElement | null)?.closest?.("a.internal-link");
    if (!link || (event.button !== 0 && event.button !== 1)) return;
    const target = extractCitations(`[[${link.getAttribute("data-href") ?? link.getAttribute("href") ?? ""}]]`)[0];
    const index = citations.findIndex(citation => citation.linkpath === target?.linkpath && citation.heading === target.heading);
    if (index < 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void open(index, event.ctrlKey || event.metaKey || event.button === 1);
  };
  bubble.addEventListener("click", onClick, true);
  bubble.addEventListener("auxclick", onClick, true);
  refresh();
  return { refresh, targets: () => citations.map((citation, index) => ({ ...citation, path: currentFile(index)?.path ?? null })), dispose: () => {
    disposed = true;
    generation++;
    bubble.removeEventListener("click", onClick, true);
    bubble.removeEventListener("auxclick", onClick, true);
  } };
}

function fillProvenance(footer: HTMLElement, checked: CheckedCitation[], open: (index: number, newLeaf: boolean) => Promise<void>): void {
  footer.empty();
  const shown = checked.slice(0, PROVENANCE_ITEMS);
  const unverified = checked.filter(c => c.status !== "found").length;
  footer.createDiv({ cls: "cc-provenance-title", text: unverified ? `Cited notes · ${unverified} unverified` : "Cited notes" });
  shown.forEach((citation, index) => {
    const item = footer.createDiv({ cls: `cc-provenance-item${citation.status === "found" ? "" : ` is-${citation.status}`}` });
    const name = citation.path ? (citation.linkpath.includes("/") ? citation.path : citation.path.split("/").pop()!).replace(/\.md$/, "") : citation.linkpath;
    const label = citation.heading ? `${name} › ${citation.heading}` : name;
    const row = item.createDiv({ cls: "cc-provenance-row" });
    if (citation.path) {
      const link = row.createEl("a", { cls: "cc-provenance-link", text: label, href: "#" });
      link.addEventListener("click", event => { event.preventDefault(); void open(index, event.ctrlKey || event.metaKey); });
    } else row.createSpan({ cls: "cc-provenance-name", text: label });
    if (citation.status !== "found") row.createSpan({ cls: "cc-provenance-status", text: citation.status === "ambiguous" ? "Multiple notes match" : citation.status === "missing" ? "Not in vault" : "Section not found" });
    if (citation.excerpt) item.createDiv({ cls: "cc-provenance-excerpt", text: citation.excerpt });
  });
  if (checked.length > shown.length) footer.createDiv({ cls: "cc-provenance-more", text: `+${checked.length - shown.length} more` });
}
