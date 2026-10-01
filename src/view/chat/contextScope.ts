import type { ContextToggles } from "../../types";

export type MentionKind = "note" | "selection" | "linked" | "vault";

const MENTION_KEY: Record<MentionKind, keyof ContextToggles> = {
  note: "activeNote",
  selection: "selection",
  linked: "linkedNotes",
  vault: "searchVault",
};

/** A tab's toggles start as a copy of the stored defaults. */
export function initialToggles(defaults: ContextToggles): ContextToggles {
  return { ...defaults };
}

export function applyMention(toggles: ContextToggles, kind: MentionKind): ContextToggles {
  return { ...toggles, [MENTION_KEY[kind]]: true };
}

/** Agent turns never pre-stuff vault search; the vault_search tool replaces it. */
export function effectiveToggles(tab: ContextToggles, turnOverride: Partial<ContextToggles> | null, agentActive: boolean): ContextToggles {
  const merged = { ...tab, ...turnOverride };
  return agentActive ? { ...merged, searchVault: false } : merged;
}
