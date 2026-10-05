import { UtilityUnavailableError } from "../providers/endpointPolicy";
import { buildVocabulary, tagId } from "../tags/vocabulary";
import {
  collapseMerges,
  planTagMerges,
  renderRunNote,
  type NoteMergePlan,
  type NoteTagInput,
} from "./mergePlan";
import {
  CLASSIFY_BATCH,
  CLASSIFY_SCHEMA,
  CLASSIFY_SYSTEM,
  MAX_CLASSIFY_BATCHES,
  MAX_TITLES,
  VerdictParseError,
  classifyRequest,
  parseVerdicts,
  type ClassifyPair,
  type Verdict,
} from "./classify";
import { ClassifierStoppedError } from "./classifierGlue";
import { normalizeOptimizeState, type OptimizeState, type StoredVerdict } from "./state";
import { tagCentroids } from "./tagCentroids";
import { scanTags, type TagScanReport } from "./tagScan";

export interface OptimizeDeps {
  tagEntries(): Array<{ path: string; tags: string[] }>;
  noteVectors(): Promise<((path: string) => number[] | null) | null>;
  noteTags(path: string): NoteTagInput | null;
  rewriteNote(plan: NoteMergePlan, map: ReadonlyMap<string, string>): Promise<{ inlineApplied: number; inlineSkipped: number; changed: string[] }>;
  orderTagTriggers(): Array<{ path: string; tag: string }>;
  writeRunNote(content: string, now: string): Promise<string>;
  getState(): OptimizeState;
  setState(next: OptimizeState): Promise<void>;
  now(): string;
  /** The only path that sends tag names or titles to a model. Rejects with UtilityUnavailableError. */
  classifier(opts: { interactive: boolean }): Promise<{
    local: boolean;
    label: string;
    model: string;
    complete(req: { system: string; user: string; schema: Record<string, unknown> }, parse: (raw: string) => Verdict[]): Promise<Verdict[]>;
  }>;
}

export interface ClassifyResult {
  judged: number;
  merge: number;
  keep: number;
  failedBatches: number;
  dropped: number;
  skipped?: "remote" | "recent" | "unavailable" | "stopped";
}

const BACKGROUND_INTERVAL_MS = 24 * 60 * 60 * 1000;
const basename = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

export interface ApplyResult {
  merges: number;
  notes: number;
  inlineSkipped: number;
  failed: string[];
  unchanged: number;
  dropped: string[];
  orders: string[];
  runNote: string | null;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function formatApplyNotice(result: ApplyResult): string {
  let text = `Merged ${count(result.merges, "tag", "tags")} across ${count(result.notes, "note", "notes")}`;
  if (result.inlineSkipped > 0) text += `, ${count(result.inlineSkipped, "inline tag", "inline tags")} skipped`;
  if (result.failed.length > 0) text += `, ${count(result.failed.length, "note", "notes")} failed`;
  if (result.unchanged > 0) text += `, ${count(result.unchanged, "note", "notes")} left unchanged`;
  if (result.dropped.length > 0) text += `, ${count(result.dropped.length, "merge", "merges")} dropped (cycle: ${result.dropped.join(", ")})`;
  if (result.orders.length > 0) {
    text += `, ${count(result.orders.length, "standing order triggers", "standing orders trigger")} on a merged tag`;
  }
  return text;
}

function vocabHas(vocab: ReturnType<typeof buildVocabulary>, v: StoredVerdict): boolean {
  return vocab.has(v.a) && vocab.has(v.b);
}

export function formatClassifyNotice(result: ClassifyResult): string {
  let text = `Model checked ${count(result.judged, "pair", "pairs")}: ${result.merge} merge, ${result.keep} keep`;
  if (result.failedBatches > 0) text += `, ${count(result.failedBatches, "batch", "batches")} failed`;
  if (result.dropped > 0) text += `, ${result.dropped} not checked (limit)`;
  return text;
}

export class OptimizeController {
  private inflight: Promise<ClassifyResult> | null = null;

  constructor(private deps: OptimizeDeps) {}

  async scan(opts: { semantic?: boolean } = {}): Promise<TagScanReport> {
    const vocab = buildVocabulary(this.deps.tagEntries(), tagId);
    let centroid: ((tag: string) => number[] | null) | undefined;
    if (opts.semantic !== false) {
      try {
        const noteVector = await this.deps.noteVectors();
        if (noteVector) {
          const memo = new Map<string, number[] | null>();
          centroid = tagCentroids(vocab, (path) => {
            if (!memo.has(path)) memo.set(path, noteVector(path));
            return memo.get(path) ?? null;
          });
        }
      } catch {
        centroid = undefined;
      }
    }
    const state = this.deps.getState();
    const report = scanTags({ vocab, ...(centroid ? { centroid } : {}), dismissed: new Set(state.dismissed) });
    return {
      ...report,
      candidates: report.candidates.map((c) => {
        const verdict = state.verdicts[c.id];
        return verdict ? { ...c, verdict } : c;
      }),
    };
  }

  async classifierInfo(): Promise<{ label: string; model: string } | { needsConfirmation: true }> {
    try {
      const { label, model } = await this.deps.classifier({ interactive: false });
      return { label, model };
    } catch (error) {
      if (error instanceof UtilityUnavailableError && error.resolution.state === "unavailable-loopback") return { needsConfirmation: true };
      throw error;
    }
  }

  classify(opts: { background?: boolean; signal?: AbortSignal } = {}): Promise<ClassifyResult> {
    if (this.inflight) {
      if (opts.background === true) return Promise.resolve({ judged: 0, merge: 0, keep: 0, failedBatches: 0, dropped: 0, skipped: "recent" });
      return this.inflight;
    }
    const run = this.runClassify(opts).finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async runClassify(opts: { background?: boolean; signal?: AbortSignal }): Promise<ClassifyResult> {
    const background = opts.background === true;
    const result: ClassifyResult = { judged: 0, merge: 0, keep: 0, failedBatches: 0, dropped: 0 };
    let classifier: Awaited<ReturnType<OptimizeDeps["classifier"]>>;
    try {
      classifier = await this.deps.classifier({ interactive: !background });
    } catch (error) {
      if (!background) throw error;
      return { ...result, skipped: "unavailable" };
    }
    if (background) {
      if (!classifier.local) return { ...result, skipped: "remote" };
      const last = Date.parse(this.deps.getState().lastBackgroundRun ?? "");
      const elapsed = Date.parse(this.deps.now()) - last;
      if (Number.isFinite(last) && elapsed >= 0 && elapsed < BACKGROUND_INTERVAL_MS) return { ...result, skipped: "recent" };
    }
    const vocab = buildVocabulary(this.deps.tagEntries(), tagId);
    const titles = (tag: string): string[] => (vocab.get(tag)?.notes ?? []).slice(0, MAX_TITLES).map(basename);
    const stored: Record<string, StoredVerdict> = {};
    let failure: Error | null = null;
    let stopped: ClassifierStoppedError | null = null;
    try {
      const report = await this.scan();
      const pending = report.candidates.filter((c) => !c.verdict && !c.evidence.some((e) => e === "separator" || e === "plural"));
      const cap = CLASSIFY_BATCH * MAX_CLASSIFY_BATCHES;
      const sent = pending.slice(0, cap);
      result.dropped = pending.length - sent.length;
      for (let i = 0; i < sent.length; i += CLASSIFY_BATCH) {
        if (opts.signal?.aborted) break;
        const batch = sent.slice(i, i + CLASSIFY_BATCH);
        const pairs: ClassifyPair[] = batch.map((c) => ({
          id: c.id,
          a: c.from,
          b: c.to,
          aCount: c.fromCount,
          bCount: c.toCount,
          aTitles: titles(c.from),
          bTitles: titles(c.to),
        }));
        let verdicts: Verdict[];
        try {
          verdicts = await classifier.complete(
            { system: CLASSIFY_SYSTEM, user: classifyRequest(pairs), schema: CLASSIFY_SCHEMA },
            (raw) => parseVerdicts(raw, pairs),
          );
        } catch (error) {
          if (error instanceof VerdictParseError) {
            result.failedBatches++;
            continue;
          }
          throw error;
        }
        for (const v of verdicts) {
          const pair = pairs.find((p) => p.id === v.id);
          if (!pair) continue;
          stored[v.id] = {
            verdict: v.verdict,
            ...(v.verdict === "merge" && v.canonical ? { canonical: v.canonical } : {}),
            a: pair.a,
            b: pair.b,
            model: classifier.model,
            at: this.deps.now(),
          };
          result.judged++;
          result[v.verdict]++;
        }
      }
    } catch (error) {
      if (error instanceof ClassifierStoppedError) stopped = error;
      else failure = error instanceof Error ? error : new Error(String(error));
    }
    if (stopped) {
      if (!background) throw stopped;
      return { ...result, skipped: "stopped" };
    }
    const state = this.deps.getState();
    const merged: Record<string, StoredVerdict> = { ...state.verdicts, ...stored };
    const verdicts = Object.fromEntries(Object.entries(merged).filter(([, v]) => vocabHas(vocab, v)));
    await this.deps.setState(normalizeOptimizeState({
      ...state,
      verdicts,
      ...(background ? { lastBackgroundRun: this.deps.now() } : {}),
    }));
    if (failure && !background) throw failure;
    return result;
  }

  async apply(merges: Array<{ from: string; to: string }>): Promise<ApplyResult> {
    const { map, dropped } = collapseMerges(merges);
    const vocab = buildVocabulary(this.deps.tagEntries(), tagId);
    const paths = new Set<string>();
    for (const from of map.keys()) for (const path of vocab.get(from)?.notes ?? []) paths.add(path);
    const byMerge = new Map<string, string[]>();
    const failed: string[] = [];
    let inlineSkipped = 0;
    let unchanged = 0;
    let notes = 0;
    for (const path of paths) {
      const input = this.deps.noteTags(path);
      if (!input) {
        failed.push(path);
        continue;
      }
      const plan = planTagMerges(map, [input])[0];
      if (!plan) {
        unchanged++;
        continue;
      }
      try {
        const result = await this.deps.rewriteNote(plan, map);
        inlineSkipped += result.inlineSkipped;
        if (result.changed.length === 0) {
          unchanged++;
          continue;
        }
        notes++;
        for (const from of result.changed) byMerge.set(from, [...(byMerge.get(from) ?? []), path]);
      } catch {
        failed.push(path);
      }
    }
    const orders = this.deps.orderTagTriggers().filter((t) => map.has(tagId(t.tag)));
    let runNote: string | null = null;
    if (notes > 0) {
      const applied = [...byMerge].map(([from, notePaths]) => ({ from, to: map.get(from) as string, paths: notePaths }));
      const now = this.deps.now();
      try {
        runNote = await this.deps.writeRunNote(renderRunNote({ applied, failed, orders }, now), now);
      } catch {
        runNote = null;
      }
    }
    return { merges: byMerge.size, notes, inlineSkipped, failed, unchanged, dropped, orders: orders.map((o) => o.path), runNote };
  }

  async dismiss(id: string): Promise<void> {
    const state = this.deps.getState();
    await this.deps.setState(normalizeOptimizeState({ ...state, dismissed: [...state.dismissed, id] }));
  }
}
