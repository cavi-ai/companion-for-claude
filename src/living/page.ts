// Shared page shell for living views: escaping and a self-contained, theme-aware
// document for the sandboxed `claude-html` frame. Pure.

/** Escape text for HTML; backticks too, so a view never closes its own code fence. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/** JSON safe to embed in a `<script type="application/json">` inside a code fence. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/`/g, "\\u0060");
}

const BASE_CSS = `
:root { color-scheme: light dark; --bg: #faf9f6; --card: #ffffff; --text: #1f1d1a; --muted: #6b665e; --line: #e4e0d8; --accent: #b4532a; --ok: #2f7d4f; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1b19; --card: #262522; --text: #ece9e3; --muted: #a39d93; --line: #3a3833; --accent: #e08a5f; --ok: #6cc38f; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; }
.lv-meta { color: var(--muted); font-size: 12px; margin-bottom: 14px; overflow-wrap: anywhere; }
button { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
`;

/** A complete HTML document with the base styles plus the view's own. */
export function page(title: string, meta: string, css: string, body: string, script = ""): string {
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>`,
    `<style>${BASE_CSS}${css}</style></head><body>`,
    `<h1>${escapeHtml(title)}</h1>`,
    meta ? `<div class="lv-meta">${escapeHtml(meta)}</div>` : "",
    body,
    script ? `<script>${script}</script>` : "",
    "</body></html>",
  ].join("\n");
}
