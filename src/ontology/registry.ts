// Loads schema notes from the ontology folder into a resolved type map.
// IO is injected (spec 2026-07-08 §2): main.ts wires the vault + obsidian's
// parseYaml. Keeps the last-good schema when a load fails (§4). A note that
// parses with per-entry errors still registers its valid entries — advisory,
// like conformance itself.

import { parseSchemaNote, resolveTypes } from "./schema";
import { ontologyDigest } from "./digest";
import type { ResolvedType, SchemaError, TypeDef } from "./types";

export interface OntologyIO {
  /** Markdown notes under the ontology folder: path + parsed frontmatter + body. */
  listSchemaNotes(): Promise<Array<{ path: string; frontmatter?: Record<string, unknown> | undefined; body: string }>>;
  parseYaml(src: string): unknown;
}

export class OntologyRegistry {
  private _resolved = new Map<string, ResolvedType>();
  private _errors: SchemaError[] = [];
  /** Reentrancy guard: only the newest load() may swap state (overlapping triggers: layout-ready, folder watcher). */
  private _loadGen = 0;
  /** The newest load(); a stale load settles with it. */
  private _latest: Promise<{ errors: readonly SchemaError[] }> | null = null;

  constructor(private io: OntologyIO) {}

  /**
   * (Re)load all schema notes. Notes without the `ontology: type` marker are
   * silently skipped (docs are welcome in the folder). If listing throws, the
   * previous schema is kept and the failure is reported as an error. If a
   * newer load() started while this one was awaiting IO, the stale load leaves
   * state untouched and settles with the newest load's result, so no awaited
   * load() resolves before state at least as new as its own start is in place.
   */
  load(): Promise<{ errors: readonly SchemaError[] }> {
    const gen = ++this._loadGen;
    const run = this.run(gen);
    this._latest = run;
    return run;
  }

  private async run(gen: number): Promise<{ errors: readonly SchemaError[] }> {
    let notes;
    try {
      notes = await this.io.listSchemaNotes();
    } catch (e) {
      if (gen !== this._loadGen && this._latest) return this._latest;
      this._errors = [{ message: `ontology load failed: ${e instanceof Error ? e.message : String(e)}` }];
      return { errors: this._errors };
    }
    if (gen !== this._loadGen && this._latest) return this._latest;
    const defs: TypeDef[] = [];
    const errors: SchemaError[] = [];
    const parseYaml = (src: string): unknown => this.io.parseYaml(src);
    for (const n of notes) {
      if (n.frontmatter?.ontology !== "type") continue;
      const r = parseSchemaNote(n.path, n.frontmatter, n.body, parseYaml);
      errors.push(...r.errors);
      if (r.def) defs.push(r.def);
    }
    const { resolved, errors: resolveErrors } = resolveTypes(defs);
    this._resolved = resolved;
    this._errors = [...errors, ...resolveErrors];
    return { errors: this._errors };
  }

  resolve(name: string): ResolvedType | undefined {
    return this._resolved.get(name);
  }

  resolved(): ReadonlyMap<string, ResolvedType> {
    return this._resolved;
  }

  errors(): readonly SchemaError[] {
    return this._errors;
  }

  digest(): string {
    return ontologyDigest([...this._resolved.values()]);
  }
}
