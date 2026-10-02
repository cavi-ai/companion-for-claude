// The bundled pdf.js legacy build + its worker (inlined as text by esbuild's
// pass 1b — see esbuild.config.mjs). Isolated in its own module so nothing
// test-imported ever resolves the .txt artifact or the pdf.js bundle.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerGz from "../../.build/pdf-worker.txt.gz";
import { inflateWorkerSource } from "./workerText";
import type { PdfDocumentLike } from "./pdf";

let workerReady = false;

function ensureWorker(): void {
  if (workerReady) return;
  const url = URL.createObjectURL(new Blob([inflateWorkerSource(workerGz)], { type: "text/javascript" }));
  pdfjs.GlobalWorkerOptions.workerSrc = url;
  workerReady = true;
}

/** Load a PDF from raw bytes for per-page text extraction. */
export async function loadPdf(data: ArrayBuffer): Promise<PdfDocumentLike> {
  ensureWorker();
  const doc = await pdfjs.getDocument({ data }).promise;
  return doc;
}
