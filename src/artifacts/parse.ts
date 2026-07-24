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
  const html = (m[1] ?? "").trim();
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
 * JS keywords and built-in globals that can legitimately appear as `name(` in an
 * inline handler without a user-defined function. Skipping these avoids false
 * "undefined function" reports for `onclick="if(x)…"`, `onclick="alert('hi')"`,
 * etc.
 */
const INLINE_HANDLER_BUILTINS = new Set([
  // control-flow / operator keywords that read as `kw(`
  "if", "for", "while", "switch", "catch", "return", "do", "with", "typeof", "void",
  "delete", "new", "in", "instanceof", "throw", "case", "await", "yield", "else",
  // common built-in globals used directly in handlers
  "alert", "confirm", "prompt", "print", "open", "close", "focus", "blur",
  "scrollTo", "scrollBy", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "parseInt", "parseFloat", "isNaN", "eval",
]);

/**
 * Check that an artifact's interactive controls actually work: every function an
 * inline handler (e.g. `onclick="switchTab('x')"`) calls must be defined in a
 * top-level `<script>`. Catches the "faux-interactive tabs" failure where the
 * model emits handlers but never the JS to drive them.
 *
 * Notes on precision:
 *  - the FULL handler body is scanned, so a second call in `a(); switchTab()` is
 *    still checked, not just the first token;
 *  - member calls (`App.switchTab(...)`) are skipped — the root object can't be
 *    validated by a text scan;
 *  - JS keywords and built-in globals are skipped (see the set above);
 *  - `<script type="module">` bodies are excluded from the "defined" corpus:
 *    module top-level declarations aren't global, so an inline handler that
 *    references them throws `ReferenceError` at runtime.
 */
export function validateArtifactInteractivity(html: string): InteractivityReport {
  const called = new Set<string>();
  // Pull each handler attribute's value, then find every `name(` call inside it.
  const handlerRe = /\bon\w+\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const callRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = handlerRe.exec(html)) !== null) {
    const body = m[1] ?? m[2] ?? "";
    let c: RegExpExecArray | null;
    while ((c = callRe.exec(body)) !== null) {
      const fn = c[1];
      if (fn && !INLINE_HANDLER_BUILTINS.has(fn)) called.add(fn);
    }
  }
  if (called.size === 0) return { ok: true, issues: [] };

  // Collect only NON-module <script> bodies — module scope isn't global.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?:\s+[^>]*)?>/gi)]
    .filter((s) => !/type\s*=\s*["']?module/i.test(s[1] ?? ""))
    .map((s) => s[2] ?? "")
    .join("\n");
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
  if (t?.[1]) return t[1].trim();
  const h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h?.[1]) return stripTags(h[1]).trim();
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
