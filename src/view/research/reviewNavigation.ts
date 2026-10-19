import type { Modal } from "obsidian";
import { ConfirmModal } from "../ConfirmModal";
import { sanitizeLoadError } from "./shared";

/** Leave a review only after its note opens, preserving edits on cancel or failure. */
export function reviewNoteOpener(modal: Modal, deps: {
  hasEdits(): boolean;
  openNote(): Promise<void>;
  showError(message: string): void;
}): () => void {
  let pending = false;
  const open = async () => {
    pending = true;
    let edited = false;
    const onEdit = () => { edited = true; };
    const fields = ["input", "textarea", "select"].flatMap((tag) => Array.from(modal.contentEl.querySelectorAll(tag)));
    for (const field of fields) { field.addEventListener("input", onEdit); field.addEventListener("change", onEdit); }
    try {
      await deps.openNote();
      if (edited) deps.showError("The note is open. Your newer review edits are still here.");
      else modal.close();
    }
    catch (cause) { deps.showError(sanitizeLoadError(cause)); }
    finally {
      for (const field of fields) { field.removeEventListener("input", onEdit); field.removeEventListener("change", onEdit); }
      pending = false;
    }
  };
  return () => {
    if (pending) return;
    if (!deps.hasEdits()) { void open(); return; }
    pending = true;
    new ConfirmModal(modal.app, {
      title: "Discard review changes?",
      body: "Opening the note will close this review. Discard your unsaved changes?",
      cta: "Discard and open",
      onResolve: (ok) => { pending = false; if (ok) void open(); },
    }).open();
  };
}
