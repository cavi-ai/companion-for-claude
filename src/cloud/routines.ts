// Pure, Obsidian-free core for dispatching a Claude Code *cloud session* via the
// Routines API "fire" endpoint. Firing a pre-created routine starts a cloud
// session that works the vault's Git repo and reports back — so you can cowork
// with Claude from a phone, where the desktop loopback MCP bridge can't run.
//
// ⚠️ The Routines API is EXPERIMENTAL and gated behind a dated `anthropic-beta`
// header. The exact endpoint / headers / payload here were captured from docs
// research (2026-06) and MUST be re-verified against current docs before
// relying on this in production:
//   https://platform.claude.com/docs/en/api/claude-code/routines-fire
// Everything wire-format-specific lives in this one module so updating it to a
// new beta revision is a single-file change.

export interface CloudDispatchConfig {
  /**
   * The routine's full "fire" endpoint, copied from the Claude Code web UI,
   * e.g. https://api.anthropic.com/v1/claude_code/routines/<id>/fire
   */
  fireUrl: string;
  /** Per-routine bearer token (sk-ant-oat…) — scoped to firing this one routine. */
  token: string;
  /** anthropic-beta header value gating the experimental Routines API. */
  betaHeader: string;
}

export interface HttpRequestSpec {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface RoutineFireResult {
  sessionId: string | null;
  sessionUrl: string | null;
}

/**
 * The fire URL should look like the Routines API endpoint, not just any https
 * URL. Shared by configError (dispatch-time gate) and the setup checklist so a
 * syntactically-valid-but-wrong endpoint can't pass one and fail the other.
 */
export function fireUrlError(fireUrl: string): string | null {
  const raw = fireUrl.trim();
  if (!raw) return "No routine endpoint set — paste your routine's “fire” URL in settings.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch (e) {
    console.debug("Claude Companion: routine fire URL parse failed", e);
    return "Routine endpoint is not a valid URL.";
  }
  if (url.protocol !== "https:") return "Routine endpoint must be an https:// URL.";
  if (!/\/claude_code\/routines\/[^/]+\/fire\/?$/.test(url.pathname)) {
    return "URL doesn't look like a routine “fire” endpoint (…/v1/claude_code/routines/<id>/fire) — copy it from the routine's page in the Claude Code web UI.";
  }
  return null;
}

/** Validate dispatch config; returns a human-readable error, or null when OK. */
export function configError(cfg: CloudDispatchConfig): string | null {
  const urlError = fireUrlError(cfg.fireUrl);
  if (urlError) return urlError;
  if (!cfg.token.trim()) return "No routine token set — generate one in the Claude Code web UI and paste it in settings.";
  if (!cfg.betaHeader.trim()) return "Missing the anthropic-beta header required by the Routines API.";
  return null;
}

/** Build the HTTP request that fires the routine with the given dispatch text. */
export function buildFireRequest(cfg: CloudDispatchConfig, text: string): HttpRequestSpec {
  const err = configError(cfg);
  if (err) throw new Error(err);
  return {
    url: cfg.fireUrl.trim(),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token.trim()}`,
      "anthropic-beta": cfg.betaHeader.trim(),
    },
    body: JSON.stringify({ text }),
  };
}

/**
 * Parse the fire response. Returns the new session's id + URL on success;
 * throws an actionable error on a non-2xx status.
 */
export function parseFireResponse(status: number, bodyText: string): RoutineFireResult {
  if (status < 200 || status >= 300) throw new Error(fireErrorMessage(status, bodyText));
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    console.debug("Claude Companion: routine fire response JSON parse failed", e);
    // 2xx but an unparseable body — treat as fired, just without a link.
    return { sessionId: null, sessionUrl: null };
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  return {
    sessionId: typeof obj.claude_code_session_id === "string" ? obj.claude_code_session_id : null,
    sessionUrl: typeof obj.claude_code_session_url === "string" ? obj.claude_code_session_url : null,
  };
}

/** Compose the dispatch text: the instruction plus any attached vault context. */
export function composeDispatchText(instruction: string, context?: string): string {
  const instr = instruction.trim();
  const ctx = context?.trim();
  if (!ctx) return instr;
  return `${instr}\n\n---\nContext from my Obsidian vault:\n\n${ctx}`;
}

/** Turn an error status + body into an actionable, specific message. */
function fireErrorMessage(status: number, bodyText: string): string {
  const detail = extractApiErrorDetail(bodyText);
  const suffix = detail ? ` — ${detail}` : "";
  switch (status) {
    case 401:
    case 403:
      return `Routine token rejected (${status})${suffix}. Regenerate the token in the Claude Code web UI and update settings.`;
    case 404:
      return `Routine not found (404)${suffix}. Check the “fire” URL — the routine id may be wrong, or the routine was deleted.`;
    case 400:
      return `Routine request rejected (400)${suffix}. The Routines API is experimental — verify the anthropic-beta header is current.`;
    case 429:
      return `Rate limited (429)${suffix}. Routine fires are capped during the research preview — wait and retry.`;
    default:
      return `Routine fire failed (${status})${suffix}.`;
  }
}

/**
 * Pull a detail message out of an Anthropic-style error body, if present.
 * Named distinctly from claude/sse.ts's `extractApiError`, which formats a
 * full status-bearing message rather than returning a bare detail.
 */
function extractApiErrorDetail(bodyText: string): string | null {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    return j.error?.message ?? j.message ?? null;
  } catch (e) {
    console.debug("Claude Companion: routine error body JSON parse failed", e);
    const t = bodyText.trim();
    return t ? t.slice(0, 200) : null;
  }
}
