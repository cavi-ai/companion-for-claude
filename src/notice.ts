import { Notice } from "obsidian";

/** Brief confirmation for an action whose result is already visible in the UI. */
export const QUICK_NOTICE_MS = 1_800;

export function quickNotice(message: string): Notice {
  return new Notice(message, QUICK_NOTICE_MS);
}
