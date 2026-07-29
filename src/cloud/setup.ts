// Guided setup for the cloud loop: turn the two static config validators into
// a live checklist the settings tab can tick step by step. Pure — the settings
// UI renders it, tests drive it directly.

import { type CloudDispatchConfig, configError as dispatchConfigError } from "./routines";
import { type RepliesConfig, configError as repliesConfigError, parseRepo } from "./replies";

export interface SetupStep {
  key: string;
  label: string;
  ok: boolean;
  /** What's wrong, when not ok. */
  detail?: string;
}

const step = (key: string, label: string, ok: boolean, detail?: string): SetupStep => ({
  key,
  label,
  ok,
  ...(detail !== undefined ? { detail } : {}),
});

/** The fire URL should look like the Routines API endpoint, not just any https URL. */
export function fireUrlError(fireUrl: string): string | null {
  const raw = fireUrl.trim();
  if (!raw) return "No routine endpoint set — paste your routine's “fire” URL in settings.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Routine endpoint is not a valid URL.";
  }
  if (url.protocol !== "https:") return "Routine endpoint must be an https:// URL.";
  if (!/\/claude_code\/routines\/[^/]+\/fire\/?$/.test(url.pathname)) {
    return "URL doesn't look like a routine “fire” endpoint (…/v1/claude_code/routines/<id>/fire) — copy it from the routine's page in the Claude Code web UI.";
  }
  return null;
}

export function dispatchSetupSteps(cfg: CloudDispatchConfig): SetupStep[] {
  const urlErr = fireUrlError(cfg.fireUrl);
  return [
    step("fire-url", "Routine “fire” URL pasted and well-formed", !urlErr, urlErr ?? undefined),
    step("token", "Per-routine token set", !!cfg.token.trim(), cfg.token.trim() ? undefined : "Generate the token in the Claude Code web UI and paste it below."),
    step("beta", "anthropic-beta header set", !!cfg.betaHeader.trim(), cfg.betaHeader.trim() ? undefined : "The Routines API is gated behind a dated beta header."),
  ];
}

export function repliesSetupSteps(cfg: RepliesConfig): SetupStep[] {
  const repoErr = !cfg.repo.trim()
    ? "Enter owner/name of your vault's GitHub repo."
    : !parseRepo(cfg.repo)
      ? "Repo must be in owner/name form (e.g. cavi-ai/my-vault)."
      : null;
  return [
    step("repo", "Vault repo in owner/name form", !repoErr, repoErr ?? undefined),
    step("branch", "Replies branch set", !!cfg.branch.trim(), cfg.branch.trim() ? undefined : "The branch the cloud session writes replies to."),
    step("folder", "Replies folder set", !!cfg.folder.trim(), cfg.folder.trim() ? undefined : "The repo folder reply notes land in."),
    step("token", "GitHub token with Contents:read", !!cfg.token.trim(), cfg.token.trim() ? undefined : "A fine-grained token with Contents read access on the repo."),
  ];
}

/** Aggregate readiness, reusing the existing validators as the source of truth. */
export function cloudSetupReady(dispatch: CloudDispatchConfig, replies: RepliesConfig): boolean {
  return dispatchConfigError(dispatch) === null && repliesConfigError(replies) === null && fireUrlError(dispatch.fireUrl) === null;
}
