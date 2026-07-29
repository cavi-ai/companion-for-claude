// Model-in-the-loop regression for the inbox-enrichment failure: extraction
// against the real local model must yield schema-valid fields, not ExtractError
// "reply was not valid JSON". Opt-in — requires a running Ollama with the
// model pulled:
//   OLLAMA_E2E=1 OLLAMA_MODEL=qwen3.6:latest pnpm exec vitest run test/sources/extract.integration.test.ts

import { describe, expect, it } from "vitest";
import { extractFields, type ExtractCompletionOpts } from "../../src/sources/extract";
import { getSchema } from "../../src/sources/registry";

const RUN = process.env.OLLAMA_E2E === "1";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.6:latest";
const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

const CLIP = `# Why local-first note apps are winning

By Jane Doe — Example Blog

Local-first software keeps your data on your device and syncs opportunistically.
In the note-taking world this means your markdown files stay yours: no lock-in,
offline by default, and plain-text longevity. Critics point at collaboration
gaps, but CRDT-based syncing is closing those fast. The piece surveys Obsidian,
Logseq, and Joplin, and argues the real moat is the plugin ecosystem, not storage.`;

/** The same request shape OllamaProvider.complete sends, over plain fetch. */
async function complete(system: string, user: string, opts?: ExtractCompletionOpts): Promise<string> {
  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      ...(opts?.responseSchema ? { format: opts.responseSchema } : {}),
      ...(opts?.disableThinking ? { think: false } : {}),
      options: { temperature: 0, num_predict: opts?.maxTokens ?? 1024 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

describe.skipIf(!RUN)("extractFields against a live Ollama", () => {
  it("returns schema-valid fields even with a thinking utility model", async () => {
    const { fields } = await extractFields(getSchema("article"), CLIP, {}, { complete });
    expect(fields.title).toBeTruthy();
    expect(fields.site).toBeTruthy();
    expect(fields.summary).toBeTruthy();
  }, 180_000);
});
