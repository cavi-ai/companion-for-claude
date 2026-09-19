// Shared reader for streaming fetch bodies. Every streaming provider
// (Anthropic, Ollama, OpenAI-compatible) reads a `ReadableStream<Uint8Array>`
// and decodes it incrementally; this centralizes the two things each got wrong
// independently: flushing the trailing decoder state (a multibyte UTF-8
// character split across the final chunk boundary) and cancelling the reader on
// every exit path (an error mid-stream otherwise leaks the connection).
// Pure/IO-shape only — no Obsidian, so it unit-tests in Node.

/**
 * Consume `body` to completion, passing each decoded chunk to `onChunk`.
 * Line framing is the caller's concern; this only decodes and manages the
 * reader's lifecycle. `onChunk` may throw to abort the read (e.g. an SSE
 * `error` event) — the reader is still cancelled.
 */
export async function readStreamBody(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    // Emit any character left in the decoder after the last byte. Without this
    // a trailing multibyte code point split across chunks is silently dropped.
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
  } finally {
    // Release the lock/connection on success, error, and abort alike. Guarded
    // because a test double's reader may not implement `cancel`.
    try {
      await reader.cancel();
    } catch {
      /* already closed or cancel unavailable */
    }
  }
}
