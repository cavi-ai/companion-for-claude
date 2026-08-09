import { describe, expect, it } from "vitest";
import { classifyEmbeddingFailure } from "../../src/semantic/recovery";

describe("classifyEmbeddingFailure", () => {
  it("turns a missing built-in model into direct recovery choices", () => {
    expect(classifyEmbeddingFailure(
      new Error("Built-in embedding model not downloaded"),
      { engine: "builtin", isMobile: false },
    )).toMatchObject({
      category: "builtin-model-missing",
      actions: [
        { id: "download-builtin", label: "Download built-in model" },
        { id: "embedding-settings", label: "Open embedding settings" },
      ],
    });
  });

  it("names an unreachable Ollama endpoint without leaking credentials", () => {
    const recovery = classifyEmbeddingFailure(
      new Error("connect ECONNREFUSED http://user:secret@127.0.0.1:11434 api_key=secret"),
      { engine: "ollama", endpoint: "http://user:secret@127.0.0.1:11434", isMobile: false },
    );
    expect(recovery.category).toBe("ollama-unreachable");
    expect(recovery.message).toContain("Ollama");
    expect(recovery.message).toContain("http://127.0.0.1:11434");
    expect(recovery.technicalDetails).not.toContain("secret");
  });

  it("does not offer an invalid retry to a mobile loopback endpoint", () => {
    const recovery = classifyEmbeddingFailure(
      new Error("fetch failed"),
      { engine: "ollama", endpoint: "http://localhost:11434", isMobile: true },
    );
    expect(recovery.category).toBe("mobile-local-endpoint");
    expect(recovery.actions.map(({ id }) => id)).not.toContain("retry-index");
    expect(recovery.actions.map(({ id }) => id)).toContain("use-builtin-embeddings");
  });

  it("classifies index persistence failures separately from provider failures", () => {
    const recovery = classifyEmbeddingFailure(
      new Error("EACCES writing semantic-index.json"),
      { engine: "builtin", isMobile: false },
    );
    expect(recovery.category).toBe("index-storage-failure");
    expect(recovery.actions.map(({ id }) => id)).toContain("retry-index");
  });
});
