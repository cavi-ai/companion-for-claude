// PDF loading on the pdf.js Obsidian ships for its own PDF viewer (loadPdfJs),
// with the worker Obsidian configures. Isolated in its own module so tests that
// import the extractor never load pdf.js.

import { loadPdfJs } from "obsidian";
import type { PdfDocumentLike } from "./pdf";

interface PdfJs {
  getDocument(source: { data: ArrayBuffer }): { promise: Promise<PdfDocumentLike> };
}

/** Load a PDF from raw bytes for per-page text extraction. */
export async function loadPdf(data: ArrayBuffer): Promise<PdfDocumentLike> {
  const pdfjs = (await loadPdfJs()) as PdfJs;
  return pdfjs.getDocument({ data }).promise;
}
