import { provenanceRows } from "../../research/provenanceView";

export function renderProvenanceReferences(el: HTMLElement, source: string, openLink: (path: string) => void): void {
  const root = el.createDiv({ cls: "cc-provenance" });
  root.createEl("h4", { cls: "cc-provenance-title", text: "References" });
  const { rows, issues } = provenanceRows(source);
  if (!rows.length && issues.length) root.createEl("p", { cls: "cc-provenance-error", text: "Provenance unreadable" });
  for (const issue of issues) root.createEl("p", { cls: "cc-provenance-error", text: issue });
  if (!rows.length) return;
  const list = root.createEl("ol", { cls: "cc-provenance-list" });
  for (const row of rows) {
    const item = list.createEl("li");
    item.createEl("strong", { text: row.heading });
    item.createSpan({ cls: "cc-provenance-status", text: ` · ${row.status} · ${row.passages} passage${row.passages === 1 ? "" : "s"}` });
    if (!row.citations.length) continue;
    const cites = item.createDiv({ cls: "cc-provenance-citations" });
    for (const citation of row.citations) {
      const link = cites.createEl("a", { cls: "internal-link", text: `[@${citation.key}] ${citation.sourceTitle}`, attr: { href: citation.sourcePath } });
      link.addEventListener("click", (event) => { event.preventDefault(); openLink(citation.sourcePath); });
    }
  }
}
