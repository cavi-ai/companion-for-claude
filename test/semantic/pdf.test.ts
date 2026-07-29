import { describe, expect, it } from "vitest";
import { assemblePageText, chunkPdfPages, extractPdfPages, pdfPagesText, type PdfDocumentLike } from "../../src/semantic/pdf";

const item = (str: string, hasEOL = false) => ({ str, hasEOL });

function fakeDoc(pages: string[][], destroyed: { value: boolean }): PdfDocumentLike {
  return {
    numPages: pages.length,
    getPage: async (n: number) => ({
      getTextContent: async () => ({ items: pages[n - 1] ?? [] }),
    }),
    destroy: async () => {
      destroyed.value = true;
    },
  };
}

describe("assemblePageText", () => {
  it("joins runs with spaces, breaks lines at EOL, and collapses whitespace", () => {
    expect(assemblePageText([item("Hello"), item("world", true), item("next"), item("line")])).toBe("Hello world\nnext line");
  });

  it("skips non-string items and trims the result", () => {
    expect(assemblePageText([{ noStr: true }, item("  padded  ")])).toBe("padded");
  });
});

describe("extractPdfPages", () => {
  it("extracts per-page text, skips empty pages, and destroys the document", async () => {
    const destroyed = { value: false };
    const doc = fakeDoc([[item("Page one text", true)], [], [item("Page three", true)]], destroyed);
    const pages = await extractPdfPages(async () => doc, new ArrayBuffer(8));
    expect(pages).toEqual([
      { page: 1, text: "Page one text" },
      { page: 3, text: "Page three" },
    ]);
    expect(destroyed.value).toBe(true);
  });

  it("destroys the document even when a page read fails", async () => {
    const destroyed = { value: false };
    const doc: PdfDocumentLike = {
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => { throw new Error("bad page"); } }),
      destroy: async () => { destroyed.value = true; },
    };
    await expect(extractPdfPages(async () => doc, new ArrayBuffer(8))).rejects.toThrow("bad page");
    expect(destroyed.value).toBe(true);
  });
});

describe("chunkPdfPages", () => {
  it("prefixes every chunk with its page locator and never crosses pages", () => {
    const long = "Sentence one is here. ".repeat(200); // ~4400 chars → multiple pieces
    const chunks = chunkPdfPages([
      { page: 1, text: "Short page." },
      { page: 2, text: long },
    ]);
    expect(chunks[0]).toMatchObject({ heading: "Page 1" });
    expect(chunks[0]!.text).toBe("Page 1\n\nShort page.");
    const pageTwo = chunks.filter((c) => c.heading === "Page 2");
    expect(pageTwo.length).toBeGreaterThan(1);
    for (const c of pageTwo) expect(c.text.startsWith("Page 2\n\n")).toBe(true);
    // Ords are stable and consecutive across pages.
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it("pdfPagesText feeds change detection with page markers", () => {
    expect(pdfPagesText([{ page: 2, text: "x" }])).toContain("--- page 2 ---");
  });
});
