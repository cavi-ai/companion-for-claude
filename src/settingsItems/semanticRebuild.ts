import type { ButtonComponent, Setting } from "obsidian";
import type { SemanticItemsContext } from "./semantic";
import { formatIndexProgress, type SemanticIndexProgress } from "../semantic/progress";

export function setSemanticActionBusy(button: ButtonComponent, busy: boolean, label: string): void {
  button.setDisabled(busy).setButtonText(label);
  button.buttonEl.toggleClass("is-running", busy);
  button.buttonEl.setAttribute("aria-busy", String(busy));
}

export function renderIndexRebuild(setting: Setting, plugin: Pick<SemanticItemsContext["plugin"], "activity" | "semantic">): () => void {
  const previousStatuses = Array.from(setting.settingEl.querySelectorAll(".cc-conn-status"));
  const status = (previousStatuses[0] as HTMLElement | undefined)
    ?? setting.settingEl.createDiv({ cls: "cc-conn-status setting-item-description" });
  status.addClass("cc-semantic-index-status");
  for (const duplicate of previousStatuses.slice(1)) duplicate.remove();
  let running = false;
  let disposed = false;
  let started = false;
  let progress: SemanticIndexProgress | null = null;
  let timer: number | null = null;
  let rebuildButton: ButtonComponent | null = null;
  const stopTimer = (): void => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const renderProgress = (): void => {
    if (!disposed && progress?.state === "running") status.setText(formatIndexProgress(progress));
  };
  void plugin
    .semantic()
    .indexer()
    ?.stats()
    .then((s) => { if (!disposed && !running && !started) status.setText(`Index: ${s.notes} note(s), ${s.chunks} chunk(s).`); })
    .catch(() => { if (!disposed && !running && !started) status.setText("Index: not built yet."); });
  setting.addButton((btn) => {
    rebuildButton = btn;
    btn.buttonEl.addClass("cc-semantic-action");
    btn
      .setButtonText("Rebuild")
      .setCta()
      .onClick(async () => {
        if (running) return;
        running = true;
        started = true;
        setSemanticActionBusy(btn, true, "Rebuilding…");
        status.removeClass("is-ok");
        status.removeClass("is-err");
        status.setText("Rebuilding index…");
        try {
          await plugin.semantic().rebuildSemanticIndex();
          const s = await plugin.semantic().indexer()?.stats();
          const outcome = plugin.activity.snapshot().records.find((record) =>
            record.kind === "semantic-index" && record.title === "Building semantic index",
          );
          if (outcome?.state === "needs-attention") {
            status.setText("Index needs attention — open Companion activity for details.");
            status.addClass("is-err");
          } else if (outcome?.state === "succeeded" && s) {
            status.setText(`Index ready · ${s.notes} note(s), ${s.chunks} chunk(s).`);
            status.addClass("is-ok");
          } else {
            status.setText("Rebuild result unavailable — open Companion activity for details.");
            status.addClass("is-err");
          }
        } catch (e) {
          status.setText(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
          status.addClass("is-err");
        } finally {
          running = false;
          stopTimer();
          setSemanticActionBusy(btn, false, "Rebuild");
        }
      });
  });
  const unsubscribe = plugin.semantic().subscribeBuildProgress((next) => {
    if (disposed) return;
    progress = next;
    if (next?.state === "running") {
      status.removeClass("is-ok");
      status.removeClass("is-err");
      running = true;
      started = true;
      if (rebuildButton) setSemanticActionBusy(rebuildButton, true, "Rebuilding…");
      renderProgress();
      if (timer === null) timer = window.setInterval(renderProgress, 1000);
    } else if (next) {
      running = false;
      stopTimer();
      if (rebuildButton) setSemanticActionBusy(rebuildButton, false, "Rebuild");
      status.setText(next.state === "succeeded"
        ? `Index ready · ${next.chunksEmbedded.toLocaleString()} chunks embedded.`
        : "Index stopped — open Companion activity for details.");
    }
  });
  return () => { disposed = true; stopTimer(); unsubscribe(); };
}
