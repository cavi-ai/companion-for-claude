// Tidy records the steps it finished and a fingerprint of the note body in
// frontmatter, so a later run skips steps already done on unchanged text. Pure.

import { fnv1aFingerprint } from "../hashing";
import { readFrontmatter, stripFrontmatter } from "../markdown/frontmatter";
import type { EnrichOptions } from "../view/EnrichModal";

export type TidyStep = Exclude<keyof EnrichOptions, "autoApply">;

export const TIDY_STEPS: readonly TidyStep[] = ["rename", "frontmatter", "links", "lint"];
export const TIDY_STEPS_KEY = "tidied";
export const TIDY_HASH_KEY = "tidy_hash";

/** Fingerprint of the note body; frontmatter and surrounding whitespace do not count. */
export function tidyBodyHash(content: string): string {
  return fnv1aFingerprint(stripFrontmatter(content).trim());
}

export interface TidyPlan {
  /** Steps a previous Tidy finished on this exact body. */
  finished: TidyStep[];
  /** The requested options with the finished steps turned off. */
  pending: EnrichOptions;
  /** Every requested step was already finished on this body. */
  done: boolean;
}

/** What a Tidy run still has to do: the requested steps minus those finished on this body. */
export function planTidy(content: string, options: EnrichOptions, parse: (yaml: string) => unknown): TidyPlan {
  const frontmatter = readFrontmatter(content, parse);
  const recorded = frontmatter?.[TIDY_STEPS_KEY];
  const finished = frontmatter?.[TIDY_HASH_KEY] === tidyBodyHash(content) && Array.isArray(recorded)
    ? TIDY_STEPS.filter((step) => recorded.includes(step))
    : [];
  const pending = { ...options };
  for (const step of finished) pending[step] = false;
  return { finished, pending, done: finished.length > 0 && !TIDY_STEPS.some((step) => pending[step]) };
}
