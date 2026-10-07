import { buildFrontmatter } from "../indexing/frontmatter";
import { sanitize } from "../memory/sanitize";
import { UtilityUnavailableError } from "../providers/endpointPolicy";
import { ClassifierStoppedError, type ClassifierHandle } from "./classifierGlue";
import { normalizeOptimizeState, type OptimizeState, type StoredTypeVerdict } from "./state";
import {
  MAX_TYPE_BATCHES,
  noteExcerpt,
  noteHeadings,
  parseTypeVerdicts,
  TYPE_BATCH,
  TYPE_SCHEMA,
  TYPE_SYSTEM,
  TypeParseError,
  typeRequest,
  type TypeChoice,
  type TypeRequestNote,
} from "./typeClassify";
import { isExcludedPath, isTyped, proposableTypes, scanUntyped, typesKeyOf, type TypeRegistry, type TypeScanNote, type TypeScanReport } from "./typeScan";

export interface TypeWrite {
  /** False when the note already had a `type` (anything but absent or null); nothing was written. */
  written: boolean;
}

export interface TypeWeaveDeps {
  notes(): TypeScanNote[];
  /** The loaded registry; null when the ontology is off. */
  registry(): Promise<TypeRegistry | null>;
  ontologyFolder(): string;
  read(path: string): Promise<string>;
  /** `processFrontMatter`: sets `type` only while `fm.type` is absent or null. Throws for a missing note. */
  setNoteType(path: string, type: string): Promise<TypeWrite>;
  writeRunNote(content: string, now: string): Promise<string>;
  getState(): OptimizeState;
  setState(next: OptimizeState): Promise<void>;
  now(): string;
  /** The only path that sends note content to a model. Rejects with UtilityUnavailableError. */
  classifier(opts: { interactive: boolean }): Promise<ClassifierHandle>;
}

export interface TypeClassifyResult {
  judged: number;
  typed: number;
  none: number;
  failedBatches: number;
  notChecked: number;
}

export interface TypeApplyResult {
  typed: number;
  skipped: string[];
  failed: Array<{ path: string; message: string }>;
  runNote: string | null;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const basename = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const MAX_DESCRIBED_PROPERTIES = 6;

export function formatTypeScanNotice(report: Pick<TypeScanReport, "status" | "candidates">): string | null {
  if (report.status === "no-registry") return "Turn on the ontology in Settings to type notes.";
  if (report.status === "no-types") return "Seed the ontology first (command: Seed ontology).";
  if (report.candidates === 0) return "Every note has a type.";
  return null;
}

export function formatTypeApplyNotice(result: TypeApplyResult): string {
  let text = `Typed ${count(result.typed, "note", "notes")}`;
  if (result.skipped.length > 0) text += `, ${count(result.skipped.length, "note", "notes")} typed since the review and left alone`;
  if (result.failed.length > 0) text += `, ${count(result.failed.length, "note", "notes")} failed`;
  return text;
}

export function formatTypeClassifyNotice(result: TypeClassifyResult): string {
  let text = `Model checked ${count(result.judged, "note", "notes")}: ${result.typed} typed, ${result.none} no fitting type`;
  if (result.failedBatches > 0) text += `, ${count(result.failedBatches, "batch", "batches")} failed`;
  if (result.notChecked > 0) text += `, ${result.notChecked} not checked (limit)`;
  return text;
}

const code = (text: string): string => `\`${text.replace(/`/g, "'").replace(/\[\[|\]\]/g, "")}\``;

/** Paths in code spans only: a wikilink here would link the notes this run typed. */
export function renderTypeRunNote(input: { applied: Array<{ path: string; type: string }>; skipped: string[]; failed: Array<{ path: string; message: string }> }, now: string): string {
  const lines = [buildFrontmatter({ type: "optimize-run", created: now, notes: input.applied.length }), "", "# Type weave", ""];
  for (const a of input.applied) lines.push(`- ${code(a.path)} → ${code(a.type)}`);
  if (input.skipped.length > 0) {
    lines.push("", "## Typed since the review, not edited", "");
    for (const p of input.skipped) lines.push(`- ${code(p)}`);
  }
  if (input.failed.length > 0) {
    lines.push("", "## Not typed", "");
    for (const f of input.failed) lines.push(`- ${code(f.path)} — ${f.message.replace(/\[\[|\]\]/g, "")}`);
  }
  return `${lines.join("\n")}\n`;
}

export class TypeWeaveController {
  private inflight: { promise: Promise<TypeClassifyResult>; signal: AbortSignal | undefined } | null = null;

  constructor(private deps: TypeWeaveDeps) {}

  async scan(): Promise<TypeScanReport> {
    return this.scanNotes(this.deps.notes(), await this.deps.registry());
  }

  private scanNotes(notes: TypeScanNote[], registry: TypeRegistry | null): TypeScanReport {
    const state = this.deps.getState();
    return scanUntyped({
      notes,
      registry,
      ontologyFolder: this.deps.ontologyFolder(),
      dismissed: new Set(state.dismissedTypes ?? []),
      verdicts: state.typeVerdicts ?? {},
    });
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

  /** Explicit user action only; a call while a live run is in flight joins it, one while an aborted run winds down starts after it. */
  classify(opts: { signal?: AbortSignal } = {}): Promise<TypeClassifyResult> {
    const current = this.inflight;
    if (current && !current.signal?.aborted) return current.promise;
    const winding = current?.promise;
    const run: Promise<TypeClassifyResult> = (async () => {
      if (winding) await winding.catch(() => undefined);
      return this.runClassify(opts);
    })().finally(() => {
      if (this.inflight?.promise === run) this.inflight = null;
    });
    this.inflight = { promise: run, signal: opts.signal };
    return run;
  }

  private async runClassify(opts: { signal?: AbortSignal }): Promise<TypeClassifyResult> {
    const result: TypeClassifyResult = { judged: 0, typed: 0, none: 0, failedBatches: 0, notChecked: 0 };
    const registry = await this.deps.registry();
    const report = this.scanNotes(this.deps.notes(), registry);
    if (report.status !== "ok" || !registry || report.pending.length === 0) return result;
    const typesKey = typesKeyOf(report.proposable);
    const classifier = await this.deps.classifier({ interactive: true });
    const choices: TypeChoice[] = report.proposable.map((name) => {
      const keys = (registry.resolve(name)?.properties ?? []).slice(0, MAX_DESCRIBED_PROPERTIES).map((p) => p.key);
      return keys.length > 0 ? { name, description: `properties: ${keys.join(", ")}` } : { name };
    });
    const sent = report.pending.slice(0, TYPE_BATCH * MAX_TYPE_BATCHES);
    result.notChecked = report.pending.length - sent.length;
    const stored: Record<string, StoredTypeVerdict> = {};
    let failure: Error | null = null;
    let stopped: ClassifierStoppedError | null = null;
    try {
      for (let i = 0; i < sent.length; i += TYPE_BATCH) {
        if (opts.signal?.aborted) break;
        const live = new Map(this.deps.notes().map((n) => [n.path, n]));
        const dismissed = new Set(this.deps.getState().dismissedTypes ?? []);
        const folder = this.deps.ontologyFolder();
        const batch: Array<{ path: string; mtime: number; request: TypeRequestNote }> = [];
        for (const item of sent.slice(i, i + TYPE_BATCH)) {
          const note = live.get(item.path);
          if (!note || isTyped(note.frontmatter) || dismissed.has(item.path) || isExcludedPath(item.path, folder)) continue;
          let content: string;
          try {
            content = sanitize(await this.deps.read(item.path));
          } catch {
            continue;
          }
          batch.push({
            path: item.path,
            mtime: note.mtime,
            request: {
              title: sanitize(basename(item.path)),
              folder: sanitize(folderOf(item.path)),
              tags: note.tags.map((t) => sanitize(t.replace(/^#+/, ""))).filter(Boolean),
              headings: noteHeadings(content),
              excerpt: noteExcerpt(content),
            },
          });
        }
        if (batch.length === 0) continue;
        let verdicts;
        try {
          verdicts = await classifier.complete(
            { system: TYPE_SYSTEM, user: typeRequest(batch.map((b) => b.request), choices), schema: TYPE_SCHEMA },
            (raw) => parseTypeVerdicts(raw, batch, report.proposable),
          );
        } catch (error) {
          if (error instanceof TypeParseError) {
            result.failedBatches++;
            continue;
          }
          throw error;
        }
        for (const v of verdicts) {
          const item = batch.find((b) => b.path === v.path);
          if (!item) continue;
          stored[v.path] = { type: v.type, model: classifier.model, at: this.deps.now(), mtime: item.mtime, types: typesKey };
          result.judged++;
          if (v.type === null) result.none++;
          else result.typed++;
        }
      }
    } catch (error) {
      if (error instanceof ClassifierStoppedError) stopped = error;
      else failure = error instanceof Error ? error : new Error(String(error));
    }
    if (stopped) throw stopped;
    if (Object.keys(stored).length > 0) {
      const state = this.deps.getState();
      await this.deps.setState(normalizeOptimizeState({ ...state, typeVerdicts: { ...(state.typeVerdicts ?? {}), ...stored } }));
    }
    if (failure) throw failure;
    return result;
  }

  /** Writes exactly the given rows' `type`; nothing else is touched. */
  async apply(rows: Array<{ path: string; type: string }>): Promise<TypeApplyResult> {
    const proposable = new Set(proposableTypes(await this.deps.registry()));
    const folder = this.deps.ontologyFolder();
    const applied: Array<{ path: string; type: string }> = [];
    const skipped: string[] = [];
    const failed: TypeApplyResult["failed"] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      if (!proposable.has(row.type)) {
        failed.push({ path: row.path, message: `'${row.type}' is not an available type` });
        continue;
      }
      if (isExcludedPath(row.path, folder)) {
        failed.push({ path: row.path, message: "Note is not eligible for typing" });
        continue;
      }
      try {
        const write = await this.deps.setNoteType(row.path, row.type);
        if (write.written) applied.push(row);
        else skipped.push(row.path);
      } catch (error) {
        failed.push({ path: row.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    let runNote: string | null = null;
    if (applied.length > 0) {
      const now = this.deps.now();
      try {
        runNote = await this.deps.writeRunNote(renderTypeRunNote({ applied, skipped, failed }, now), now);
      } catch {
        runNote = null;
      }
    }
    return { typed: applied.length, skipped, failed, runNote };
  }

  async dismiss(path: string): Promise<void> {
    const state = this.deps.getState();
    await this.deps.setState(normalizeOptimizeState({ ...state, dismissedTypes: [...(state.dismissedTypes ?? []), path] }));
  }
}
