import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "obsidian";
import { fuseKeywordAndSemantic, keywordVaultSearch } from "../../src/context/hybridSearch";
import { SemanticIndexer } from "../../src/semantic/indexer";
import type { PersistedIndex } from "../../src/semantic/store";
import { HASH_EMBEDDER_MODEL, hashEmbedder } from "../fakes/hashEmbedder";

const ROOT = join(__dirname, "..", "fixtures", "retrieval");
const NOTES_DIR = join(ROOT, "notes");
const TOP_K = 10;

interface LabeledQuery { kind: string; query: string; relevant: string[] }
type Mode = (query: string) => Promise<string[]>;
interface Metrics { recall5: number; mrr: number }

const notes: Record<string, string> = {};
for (const topic of readdirSync(NOTES_DIR)) {
  for (const file of readdirSync(join(NOTES_DIR, topic))) {
    notes[`${topic}/${file}`] = readFileSync(join(NOTES_DIR, topic, file), "utf8");
  }
}
const queries = JSON.parse(readFileSync(join(ROOT, "queries.json"), "utf8")) as LabeledQuery[];

function indexerOver(load: () => Promise<unknown>): SemanticIndexer {
  return new SemanticIndexer({
    embeddingModel: HASH_EMBEDDER_MODEL,
    listMarkdown: () => Object.keys(notes).map((path) => ({ path, mtime: 1 })),
    read: async (path) => notes[path] ?? "",
    embed: hashEmbedder.embed,
    load,
    save: async (data) => { saved = JSON.parse(JSON.stringify(data)) as PersistedIndex; },
  });
}

let saved: PersistedIndex | null = null;
let semanticIndexer: SemanticIndexer;
let reloadedIndexer: SemanticIndexer;
const app = new App();
for (const [path, text] of Object.entries(notes)) app.vault.seed(path, text);

const keywordMode: Mode = async (query) => (await keywordVaultSearch(app, query)).slice(0, TOP_K).map((h) => h.path);
const semanticWith = (indexer: () => SemanticIndexer): Mode => async (query) => (await indexer().search(query, TOP_K)).map((h) => h.path);
const hybridWith = (indexer: () => SemanticIndexer): Mode => async (query) => {
  const keyword = (await keywordVaultSearch(app, query)).slice(0, TOP_K);
  const semantic = await indexer().search(query, TOP_K);
  return fuseKeywordAndSemantic(keyword, semantic, TOP_K).map((f) => f.path);
};

async function evaluate(mode: Mode, subset: (q: LabeledQuery) => boolean = () => true): Promise<Metrics> {
  const picked = queries.filter(subset);
  let recall = 0;
  let rr = 0;
  for (const q of picked) {
    const ranked = await mode(q.query);
    recall += q.relevant.filter((p) => ranked.slice(0, 5).includes(p)).length / q.relevant.length;
    const first = ranked.findIndex((p) => q.relevant.includes(p));
    if (first >= 0) rr += 1 / (first + 1);
  }
  return { recall5: recall / picked.length, mrr: rr / picked.length };
}

describe("retrieval quality on the labeled fixture corpus", () => {
  beforeAll(async () => {
    semanticIndexer = indexerOver(async () => null);
    const result = await semanticIndexer.build();
    expect(result.failureCount).toBe(0);
    expect(result.indexed).toBe(Object.keys(notes).length);
    reloadedIndexer = indexerOver(async () => JSON.parse(JSON.stringify(saved)));
  });

  it("covers a corpus and query set large enough to be meaningful", () => {
    expect(Object.keys(notes).length).toBeGreaterThanOrEqual(40);
    expect(queries.length).toBeGreaterThanOrEqual(30);
    for (const q of queries) for (const p of q.relevant) expect(notes[p]).toBeDefined();
  });

  it("keyword search keeps its recall@5 and MRR", async () => {
    const m = await evaluate(keywordMode);
    expect(m.recall5).toBeGreaterThanOrEqual(KEYWORD_FLOOR.recall5);
    expect(m.mrr).toBeGreaterThanOrEqual(KEYWORD_FLOOR.mrr);
  });

  it("semantic search keeps its recall@5 and MRR", async () => {
    const m = await evaluate(semanticWith(() => semanticIndexer));
    expect(m.recall5).toBeGreaterThanOrEqual(SEMANTIC_FLOOR.recall5);
    expect(m.mrr).toBeGreaterThanOrEqual(SEMANTIC_FLOOR.mrr);
  });

  it("hybrid search keeps its recall@5 and MRR", async () => {
    const m = await evaluate(hybridWith(() => semanticIndexer));
    expect(m.recall5).toBeGreaterThanOrEqual(HYBRID_FLOOR.recall5);
    expect(m.mrr).toBeGreaterThanOrEqual(HYBRID_FLOOR.mrr);
  });

  it("hybrid recall@5 stays within 0.05 of the better single mode", async () => {
    const keyword = await evaluate(keywordMode);
    const semantic = await evaluate(semanticWith(() => semanticIndexer));
    const hybrid = await evaluate(hybridWith(() => semanticIndexer));
    expect(hybrid.recall5).toBeGreaterThanOrEqual(Math.max(keyword.recall5, semantic.recall5) - 0.05);
  });

  it("semantic beats keyword on paraphrases and keyword beats semantic on exact terms", async () => {
    const para = (q: LabeledQuery) => q.kind === "paraphrase";
    const exact = (q: LabeledQuery) => q.kind === "exact";
    const semanticMode = semanticWith(() => semanticIndexer);
    expect((await evaluate(semanticMode, para)).mrr).toBeGreaterThan((await evaluate(keywordMode, para)).mrr);
    expect((await evaluate(keywordMode, exact)).mrr).toBeGreaterThanOrEqual((await evaluate(semanticMode, exact)).mrr);
  });

  it("a store reloaded from its persisted form ranks identically", async () => {
    expect(saved).not.toBeNull();
    const before = await evaluate(semanticWith(() => semanticIndexer));
    const after = await evaluate(semanticWith(() => reloadedIndexer));
    expect(after).toEqual(before);
    const hybridBefore = await evaluate(hybridWith(() => semanticIndexer));
    const hybridAfter = await evaluate(hybridWith(() => reloadedIndexer));
    expect(hybridAfter).toEqual(hybridBefore);
    const rankOfRelevant = async (indexer: () => SemanticIndexer, q: LabeledQuery) =>
      q.relevant.map((p) => semanticWith(indexer)(q.query).then((ranked) => ranked.indexOf(p)));
    for (const q of queries) {
      expect(await Promise.all(await rankOfRelevant(() => reloadedIndexer, q))).toEqual(await Promise.all(await rankOfRelevant(() => semanticIndexer, q)));
    }
  });
});

// Measured 0.694/0.677, 0.952/0.956, 0.952/0.868 (recall@5/MRR); floors sit ~0.03 below.
const KEYWORD_FLOOR: Metrics = { recall5: 0.66, mrr: 0.64 };
const SEMANTIC_FLOOR: Metrics = { recall5: 0.92, mrr: 0.92 };
const HYBRID_FLOOR: Metrics = { recall5: 0.92, mrr: 0.83 };
