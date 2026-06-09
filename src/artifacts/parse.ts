// Pure (Obsidian-free) artifact parsing helpers, unit-testable in isolation.

export interface ExtractedArtifact {
  /** Inner HTML (a full document) extracted from a ```claude-html block. */
  html: string;
  /** A best-effort title pulled from <title> or the first heading. */
  title: string;
}

const CLAUDE_HTML_RE = /```claude-html[^\n]*\n([\s\S]*?)```/i;
// Also accept a plain ```html block that contains a full document.
const HTML_DOC_RE = /```html[^\n]*\n(\s*<!DOCTYPE[\s\S]*?)```/i;

/** Find the first renderable HTML artifact inside an assistant message. */
export function extractArtifact(markdown: string): ExtractedArtifact | null {
  const m = CLAUDE_HTML_RE.exec(markdown) ?? HTML_DOC_RE.exec(markdown);
  if (!m) return null;
  const html = m[1].trim();
  if (html.length === 0) return null;
  return { html, title: titleFromHtml(html) };
}

/**
 * Strip HTML tags safely. A single-pass `replace(/<[^>]+>/g, "")` is vulnerable
 * to multi-character reconstruction (e.g. `<<b>script>` → `script>`), so we loop
 * until the string stops changing, then remove any stray angle brackets that
 * never formed a complete tag. Used for plain-text titles, not for sanitizing
 * HTML that will be re-rendered.
 */
export function stripTags(html: string, replacement = ""): string {
  let prev: string;
  let out = html;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, replacement);
  } while (out !== prev);
  return out.replace(/[<>]/g, "");
}

export interface InteractivityReport {
  ok: boolean;
  /** Handler functions referenced by markup but never defined in a <script>. */
  issues: string[];
}

/**
 * Check that an artifact's interactive controls actually work: every inline
 * handler (e.g. `onclick="switchTab('x')"`) must reference a function that's
 * defined in a `<script>`. Catches the "faux-interactive tabs" failure where the
 * model emits handlers but never the JS to drive them.
 */
export function validateArtifactInteractivity(html: string): InteractivityReport {
  const called = new Set<string>();
  const handlerRe = /\bon\w+\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = handlerRe.exec(html)) !== null) called.add(m[1]);
  if (called.size === 0) return { ok: true, issues: [] };

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((s) => s[1]).join("\n");
  const issues: string[] = [];
  for (const fn of called) {
    const def = new RegExp(
      `function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\b|\\b${fn}\\s*=\\s*(?:function|\\()|window\\.${fn}\\s*=`,
    );
    if (!def.test(scripts)) issues.push(`${fn}() is wired to a control but never defined in a <script>`);
  }
  return { ok: issues.length === 0, issues };
}

export function titleFromHtml(html: string): string {
  const t = /<title>([^<]+)<\/title>/i.exec(html);
  if (t) return t[1].trim();
  const h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h) return stripTags(h[1]).trim();
  return "Claude artifact";
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Untitled"
  );
}
