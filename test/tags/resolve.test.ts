import { describe, it, expect } from "vitest";
import { buildVocabulary } from "../../src/tags/vocabulary";
import { createTagResolver, resolveTags, variantKeys } from "../../src/tags/resolve";

function vocabOf(counts: Record<string, number>) {
  const files: Array<{ path: string; tags: string[] }> = [];
  for (const [tag, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) files.push({ path: `${tag}-${i}.md`, tags: [tag] });
  }
  return buildVocabulary(files);
}

describe("resolveTags", () => {
  it("maps a plural to the singular in the vault", () => {
    expect(resolveTags(["llms"], vocabOf({ llm: 3 }))).toEqual([
      { input: "llms", tag: "llm", match: "variant", via: "plural" },
    ]);
  });

  it("maps separator variants", () => {
    const vocab = vocabOf({ "ai-agents": 2, "machine-learning": 4 });
    expect(resolveTags(["ai_agents", "machinelearning"], vocab)).toEqual([
      { input: "ai_agents", tag: "ai-agents", match: "variant", via: "separator" },
      { input: "machinelearning", tag: "machine-learning", match: "variant", via: "separator" },
    ]);
  });

  it("does not map token-order, prefix, or non-plural pairs", () => {
    const vocab = vocabOf({ "design-system": 2, new: 2, window: 2, clas: 2, "agents/ai": 2 });
    const out = resolveTags(["system-design", "news", "windows", "class", "ai/agents"], vocab);
    expect(out.map((r) => [r.tag, r.match])).toEqual([
      ["system-design", "new"],
      ["news", "new"],
      ["windows", "new"],
      ["class", "new"],
      ["ai/agents", "new"],
    ]);
  });

  it("never singularizes short or invariant words", () => {
    const vocab = vocabOf({ cs: 2, io: 2, aw: 2 });
    expect(resolveTags(["css", "ios", "aws"], vocab).every((r) => r.match === "new")).toBe(true);
    expect(variantKeys("css").plural).toEqual(["css"]);
    expect(variantKeys("windows").plural).toEqual(["windows"]);
  });

  it("singularizes to candidate forms", () => {
    expect(variantKeys("categories").plural).toEqual(["category", "categorie"]);
    expect(variantKeys("boxes").plural).toEqual(["box", "boxe"]);
    expect(variantKeys("classes").plural).toEqual(["class", "classe"]);
    expect(variantKeys("class").plural).toEqual(["class"]);
    expect(variantKeys("ai/ml-models").plural).toEqual(["ai/mlmodel", "ai/mlmodels"]);
    expect(variantKeys("ai/ml-models").separator).toBe("ai/mlmodels");
  });

  it("never remaps a tag that already exists", () => {
    expect(resolveTags(["LLMs"], vocabOf({ llm: 9, llms: 2 }))).toEqual([{ input: "llms", tag: "llms", match: "exact" }]);
    expect(resolveTags(["canva"], vocabOf({ canvas: 5, canva: 2 }))).toEqual([{ input: "canva", tag: "canva", match: "exact" }]);
  });

  it("picks the most used variant for a new input, ties shorter then alphabetical", () => {
    expect(resolveTags(["ai-agents"], vocabOf({ aiagent: 1, "ai-agent": 4 }))[0].tag).toBe("ai-agent");
    expect(resolveTags(["llms"], vocabOf({ llm: 2, "ll-m": 2 }))[0].tag).toBe("llm");
  });

  it.each([
    ["caches", ["cache"], "cache"],
    ["sizes", ["size"], "size"],
    ["movies", ["movie"], "movie"],
    ["cookies", ["cookie"], "cookie"],
    ["batches", ["batch"], "batch"],
    ["boxes", ["box"], "box"],
    ["categories", ["category"], "category"],
    ["apis", ["api"], "api"],
    ["biases", ["bias"], "bias"],
    ["statuses", ["status"], "status"],
    ["aliases", ["alias"], "alias"],
    ["lenses", ["lens"], "lens"],
    ["canvases", ["canvas"], "canvas"],
    ["classes", ["class"], "class"],
    ["teams", ["team"], "team"],
    ["llm", ["llms"], "llms"],
    ["ai-agent", ["ai-agents"], "ai-agents"],
    ["ai/agent", ["ai/agents"], "ai/agents"],
  ])("maps plural forms: %s", (input, tags, expected) => {
    const vocab = vocabOf(Object.fromEntries(tags.map((t) => [t, 1])));
    expect(resolveTags([input], vocab)).toEqual([{ input, tag: expected, match: "variant", via: "plural" }]);
  });

  it.each([
    ["planes", ["plan"]],
    ["canva", ["canvas"]],
    ["electronic", ["electronics"]],
    ["blue", ["blues"]],
    ["http", ["https"]],
    ["sale", ["sales"]],
    ["cases", ["cas"]],
    ["uses", ["us"]],
    ["buses", ["bus"]],
    ["prs", ["pr"]],
    ["news", ["new"]],
    ["windows", ["window"]],
    ["class", ["clas"]],
    ["agents", ["ai/agents"]],
    ["kubernets", ["kubernetes"]],
    ["system-design", ["design-system"]],
    ["agents/ai", ["ai/agents"]],
  ])("does not map unrelated pair: %s", (input, tags) => {
    const vocab = vocabOf(Object.fromEntries(tags.map((t) => [t, 1])));
    expect(resolveTags([input], vocab)).toEqual([{ input, tag: input, match: "new" }]);
  });

  it.each([
    ["machinelearning", ["machine-learning"], "machine-learning"],
    ["ai_agents", ["ai-agents"], "ai-agents"],
    ["sales-force", ["salesforce"], "salesforce"],
  ])("maps separator variants: %s", (input, tags, expected) => {
    const vocab = vocabOf(Object.fromEntries(tags.map((t) => [t, 1])));
    expect(resolveTags([input], vocab)).toEqual([{ input, tag: expected, match: "variant", via: "separator" }]);
  });

  it("a resolver built once matches resolveTags", () => {
    const vocab = vocabOf({ llm: 3, "ai-agents": 2 });
    const resolve = createTagResolver(vocab);
    const raw = ["LLMs", "ai_agent", "rust"];
    const viaResolver = raw.map(resolve);
    expect(viaResolver.map((r) => r?.tag)).toEqual(resolveTags(raw, vocab).map((r) => r.tag));
    expect(resolve("#")).toBeNull();
    expect(raw.map(resolve)).toEqual(viaResolver);
  });

  it("breaks ties by exact, then shorter, then alphabetical", () => {
    expect(resolveTags(["llm"], vocabOf({ "ai-agent": 1, "ai-agents": 1, aiagent: 1 }))).toEqual([
      { input: "llm", tag: "llm", match: "new" },
    ]);
    expect(resolveTags(["ai-agents"], vocabOf({ aiagent: 1, "ai-agent": 1 }))[0].tag).toBe("aiagent");
    expect(resolveTags(["abc"], vocabOf({ "ab-c": 1, "a-bc": 1 }))[0].tag).toBe("a-bc");
  });

  it("writes a tag with no family unchanged as new", () => {
    expect(resolveTags(["Brand New"], vocabOf({ llm: 1 }))).toEqual([{ input: "brand-new", tag: "brand-new", match: "new" }]);
  });

  it("drops empty tags and dedupes by resolved tag in first-seen order", () => {
    const out = resolveTags(["#", "llms", "LLM", "rust"], vocabOf({ llm: 3 }));
    expect(out.map((r) => r.tag)).toEqual(["llm", "rust"]);
  });
});
