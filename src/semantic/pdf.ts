// PDF text extraction and page-locator chunking for the semantic index. Pure:
// the pdf.js loader is injected (main.ts wires the bundled legacy build via a
// Blob-URL worker), so the assembly/chunking logic unit-tests with fakes.
//
// Page numbers ride inside the chunk text ("Page N" prefix + heading), so the
// store and search need no schema change and snippets/evidence keep locators.

import { splitToSize, type Chunk } from "./chunk";

export interface PdfPage {
  /** 1-based page number. */
  page: number;
  text: string;
}

/** Minimal shape of a loaded pdf.js document (the real one is PDFDocumentProxy). */
export interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
  destroy?(): Promise<void>;
}

export type PdfLoader = (data: ArrayBuffer) => Promise<PdfDocumentLike>;

interface TextItem {
  str?: unknown;
  hasEOL?: unknown;
}

/** Join one page's text-content items: spaces between runs, newline at line ends. */
export function assemblePageText(items: unknown[]): string {
  let out = "";
  for (const raw of items) {
    const item = raw as TextItem;
    if (typeof item.str !== "string") continue;
    out += item.str;
    out += item.hasEOL ? "\n" : " ";
  }
  return out.replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract per-page text from a PDF. Throws (caller skips the file) on unreadable/encrypted input. */
export async function extractPdfPages(load: PdfLoader, data: ArrayBuffer): Promise<PdfPage[]> {
  const doc = await load(data);
  try {
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = assemblePageText(content.items);
      if (text) pages.push({ page: n, text });
    }
    return pages;
  } finally {
    await doc.destroy?.();
  }
}

/** Stable hash input for change detection across a PDF's extracted pages. */
export function pdfPagesText(pages: PdfPage[]): string {
  return pages.map((p) => `\n--- page ${p.page} ---\n${p.text}`).join("\n");
}

const MAX_CHARS = 1500;
const OVERLAP = 150;

/**
 * Chunk extracted pages, capping piece size but never crossing a page boundary —
 * the "Page N" locator prefix stays exact for every chunk.
 */
export function chunkPdfPages(pages: PdfPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  let ord = 0;
  for (const p of pages) {
    const heading = `Page ${p.page}`;
    for (const piece of splitToSize(p.text, MAX_CHARS, OVERLAP)) {
      const text = `${heading}\n\n${piece}`.trim();
      if (text) chunks.push({ ord: ord++, text, heading });
    }
  }
  return chunks;
}
