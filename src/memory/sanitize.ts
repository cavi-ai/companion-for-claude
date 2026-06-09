// Pure secret-redaction for text pulled out of Claude Code transcripts before it
// is persisted anywhere (a vault note, a digest, a log). Tool results and command
// output routinely contain tokens, keys, and credentials — this scrubs the common
// shapes. High-precision patterns only: we'd rather miss an exotic secret than
// mangle ordinary prose. Sanitization is a first-class step in the memory
// pipeline, not a polish pass — nothing leaves the machine unscrubbed.

export interface Redaction {
  kind: string;
  count: number;
}

export interface SanitizeResult {
  text: string;
  redactions: Redaction[];
}

const MASK = "‹REDACTED›";

/** Standalone secret shapes that are masked entirely wherever they appear. */
const TOKEN_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
  { kind: "private-key-block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
];

// `NAME=value` / `"name": "value"` where the name looks secret. Keeps the key
// (useful context) and masks only the value.
const ASSIGNMENT_RE =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY))\b(\s*[:=]\s*)(['"]?)[^\s'"]{6,}\3/gi;

/** Scrub known secret shapes from text, reporting what was redacted. */
export function sanitizeWithReport(text: string): SanitizeResult {
  const redactions: Redaction[] = [];
  let out = text;

  let assignments = 0;
  out = out.replace(ASSIGNMENT_RE, (_m, key: string, sep: string) => {
    assignments++;
    return `${key}${sep}${MASK}`;
  });
  if (assignments > 0) redactions.push({ kind: "secret-assignment", count: assignments });

  for (const { kind, re } of TOKEN_PATTERNS) {
    let count = 0;
    out = out.replace(re, () => {
      count++;
      return MASK;
    });
    if (count > 0) redactions.push({ kind, count });
  }

  return { text: out, redactions };
}

/** Scrub known secret shapes from text. */
export function sanitize(text: string): string {
  return sanitizeWithReport(text).text;
}
