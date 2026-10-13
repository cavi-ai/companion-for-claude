import type { App } from "obsidian";
import { ChoiceModal } from "./ChoiceModal";

/** Offers a semantic index rebuild after an embedding model or engine switch. */
export function offerIndexRebuild(app: App, label: string, rebuild: () => Promise<void>): void {
  new ChoiceModal<"rebuild" | "later">(app, {
    title: "Rebuild the semantic index?",
    message: `Embeddings now come from ${label}, so the existing index no longer applies. Rebuild it now, or it refreshes gradually as notes change.`,
    buttons: [
      { label: "Rebuild now", value: "rebuild", cta: true },
      { label: "Later", value: "later" },
    ],
    fallback: "later",
    onChoice: (c) => {
      if (c === "rebuild") void rebuild();
    },
  }).open();
}
