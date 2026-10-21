import { type App, Notice, TFile, setIcon } from "obsidian";

/** Navigate only to an existing Canvas reported by the successful vault tool. */
export function renderCanvasResult(app: App, parent: HTMLElement, name: string, result: string, ok: boolean): void {
  if (!ok || name !== "canvas_create") return;
  const path = /^Created canvas: (.+\.canvas) \(\d+ nodes, \d+ edges\)$/.exec(result)?.[1];
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) return;
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || file.extension !== "canvas") return;
  const row = parent.createDiv({ cls: "cc-canvas-result" });
  setIcon(row.createSpan({ cls: "cc-canvas-result-icon", attr: { "aria-hidden": "true" } }), "layout-dashboard");
  row.createSpan({ cls: "cc-canvas-result-title", text: file.basename });
  const open = row.createEl("button", { cls: "cc-canvas-open", text: "Open Canvas" });
  open.addEventListener("click", () => {
    if (app.vault.getAbstractFileByPath(file.path) !== file) {
      new Notice("This Canvas is no longer in the vault.");
      return;
    }
    void app.workspace.getLeaf("tab").openFile(file).catch(() => new Notice("Couldn't open this Canvas. Try opening it from the file explorer."));
  });
}
