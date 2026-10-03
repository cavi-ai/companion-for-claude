// Pure: an artifact as a standalone document, sandbox CSP included.

import { withCsp } from "../artifacts/renderInline";

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function artifactPageHtml(html: string, title: string): string {
  let doc = /<html[\s>]/i.test(html) ? html : `<html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  if (!/<title[\s>]/i.test(doc)) {
    const tag = `<title>${escapeHtml(title)}</title>`;
    doc = /<head[\s>]/i.test(doc)
      ? doc.replace(/<head[^>]*>/i, (m) => `${m}${tag}`)
      : doc.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  }
  const guarded = withCsp(doc);
  return /^\s*<!doctype/i.test(guarded) ? guarded : `<!doctype html>${guarded}`;
}
