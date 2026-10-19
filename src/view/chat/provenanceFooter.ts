import { type App, TFile } from "obsidian";
import { checkCitations, extractCitations, type CheckedCitation } from "../../chat/provenance";

/** Most cited notes listed under one reply; the rest are counted. */
const PROVENANCE_ITEMS = 12;

/** The notes a reply cites, each checked against the vault; a found citation opens its note at the cited section. */
export function renderProvenance(app: App, bubble: HTMLElement, full: string): void {
  const citations = extractCitations(full);
  if (citations.length === 0) return;
  const footer = bubble.createDiv({ cls: "cc-provenance" });
  const vault = {
    resolve: (linkpath: string) => app.metadataCache.getFirstLinkpathDest(linkpath, "")?.path ?? null,
    read: (path: string) => {
      const file = app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? app.vault.cachedRead(file) : Promise.resolve("");
    },
  };
  void checkCitations(citations, vault)
    .then((checked) => fillProvenance(app, footer, checked))
    .catch(() => footer.remove());
}

function fillProvenance(app: App, footer: HTMLElement, checked: CheckedCitation[]): void {
  const shown = checked.slice(0, PROVENANCE_ITEMS);
  const unverified = checked.filter((c) => c.status !== "found").length;
  footer.createDiv({ cls: "cc-provenance-title", text: unverified > 0 ? `Cited notes · ${unverified} unverified` : "Cited notes" });
  for (const citation of shown) {
    const item = footer.createDiv({ cls: `cc-provenance-item${citation.status === "found" ? "" : ` is-${citation.status}`}` });
    const name = citation.path ? citation.path.split("/").pop()!.replace(/\.md$/, "") : citation.linkpath;
    const label = citation.heading ? `${name} › ${citation.heading}` : name;
    const row = item.createDiv({ cls: "cc-provenance-row" });
    if (citation.path) {
      const link = row.createEl("a", { cls: "cc-provenance-link", text: label, href: "#" });
      const target = citation.status === "found" && citation.heading ? `${citation.path}#${citation.heading}` : citation.path;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void app.workspace.openLinkText(target, "", false);
      });
    } else {
      row.createSpan({ cls: "cc-provenance-name", text: label });
    }
    if (citation.status !== "found") {
      row.createSpan({ cls: "cc-provenance-status", text: citation.status === "missing" ? "Not in vault" : "Section not found" });
    }
    if (citation.excerpt) item.createDiv({ cls: "cc-provenance-excerpt", text: citation.excerpt });
  }
  if (checked.length > shown.length) footer.createDiv({ cls: "cc-provenance-more", text: `+${checked.length - shown.length} more` });
}
