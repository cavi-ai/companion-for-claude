import type { App } from "obsidian";
import { ChoiceModal } from "../ChoiceModal";
import type { Composer } from "./Composer";
import type { ConversationDrafts } from "./conversationDrafts";

/** Confirm before replacing unfinished text; follow-up actions run only after acceptance. */
export function reuseDraft(app: App, composer: Composer, drafts: ConversationDrafts, text: string, afterReplace?: () => void): void {
  const apply = () => { composer.setDraft(text); afterReplace?.(); };
  const original = composer.draft();
  if (!original.trim() || original === text) {
    apply();
    return;
  }
  const generation = drafts.generation;
  const input = composer.inputEl;
  const cancel = () => modal.close();
  const modal = new ChoiceModal(app, {
    title: "Replace current draft?",
    message: "Overwrite?",
    buttons: [{ label: "Keep draft", value: "keep" }, { label: "Replace draft", value: "replace" }],
    fallback: "keep",
    onChoice: (choice) => {
      input.removeEventListener("input", cancel);
      // Obsidian restores the previous focus after onClose returns.
      queueMicrotask(() => {
        if (drafts.generation !== generation || composer.draft() !== original) return;
        if (choice === "replace") apply();
        else input.focus();
      });
    },
  });
  input.addEventListener("input", cancel, { once: true });
  modal.open();
}
