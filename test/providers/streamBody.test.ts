import { describe, it, expect, vi } from "vitest";
import { readStreamBody } from "../../src/providers/streamBody";

/** A body whose reader yields the given byte chunks, tracking cancel(). */
function streamingBody(chunks: Uint8Array[]): { body: ReadableStream<Uint8Array>; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn().mockResolvedValue(undefined);
  let i = 0;
  const body = {
    getReader: () => ({
      read: () => (i < chunks.length ? Promise.resolve({ done: false, value: chunks[i++] }) : Promise.resolve({ done: true, value: undefined })),
      cancel,
    }),
  } as unknown as ReadableStream<Uint8Array>;
  return { body, cancel };
}

const enc = new TextEncoder();

describe("readStreamBody", () => {
  it("decodes each chunk in order", async () => {
    const { body } = streamingBody([enc.encode("Hel"), enc.encode("lo")]);
    const parts: string[] = [];
    await readStreamBody(body, (t) => parts.push(t));
    expect(parts).toEqual(["Hel", "lo"]);
  });

  it("flushes a multibyte character split across the final chunk boundary", async () => {
    // "é" is 0xC3 0xA9 — split between two reads.
    const bytes = enc.encode("café");
    const split = bytes.length - 2;
    const { body } = streamingBody([bytes.slice(0, split), bytes.slice(split)]);
    const parts: string[] = [];
    await readStreamBody(body, (t) => parts.push(t));
    expect(parts.join("")).toBe("café");
  });

  it("cancels the reader when onChunk throws mid-stream", async () => {
    const { body, cancel } = streamingBody([enc.encode("a"), enc.encode("b")]);
    await expect(
      readStreamBody(body, (t) => {
        if (t === "b") throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the reader on normal completion", async () => {
    const { body, cancel } = streamingBody([enc.encode("x")]);
    await readStreamBody(body, () => {});
    expect(cancel).toHaveBeenCalledOnce();
  });
});
