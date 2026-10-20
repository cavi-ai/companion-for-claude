import { App, TFile, parseYaml } from "obsidian";
import { vaultVocabulary } from "../../tags/vaultTags";
import { createTagResolver, type ResolvedTag } from "../../tags/resolve";
import type { McpToolDef, ToolOutput } from "../protocol";
import type { ToolRecord } from "../toolRecord";
import type { VaultToolsOptions } from "../vaultTools";
import { lookupRelationTargetType } from "../../vault/vaultFiles";
import { buildFrontmatter, normalizeTags, type FrontmatterData } from "../../indexing/frontmatter";
import { conform } from "../../ontology/conform";
import { replaceSection } from "../edit";
import { readFrontmatter, stripFrontmatter } from "../../markdown/frontmatter";
import { DELEGABLE_RESEARCH_KEYS, RESEARCH_ROUTE_HINT, planResearchRouting, runResearchRouting, type ResearchRoutePlan } from "../researchRouting";
import { parseResearchRecord } from "../../research/parse";
import type { ResearchRecord } from "../../research/types";
import type { ResearchRepository } from "../../research/repository";
import { applyPatch, type PatchTarget } from "../patch";
import { assertVaultPath, ensureFolder, optStr, read, resolveFile, str, uniquePath, write } from "./context";

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function optObj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** note_create base-frontmatter keys the model's `properties` may never overwrite. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(["type", "title", "created", "source", "tags"]);

/**
 * Machine-owned frontmatter keys the generic frontmatter writers
 * (update_frontmatter, note_patch kind=frontmatter) may never set. These encode
 * plugin identity/state — a research record's type, a memory digest's
 * session_id, an inbox clip's enrichment flag, a source's content fingerprint —
 * so an agent scribbling over them silently breaks research parsing, session
 * dedup, and triage. Dedicated flows own these keys.
 */
const RESERVED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  // identity / schema
  "type",
  "type_name",
  "ontology",
  // research records (research/parse.ts, research/render.ts): the record type
  // gate plus the relations and locator/state fields the parser validates.
  "project",
  "source",
  "source_kind",
  "canonical_id",
  "source_fingerprint",
  "content_fingerprint",
  "discovery_provenance",
  "zotero_key",
  "arxiv_id",
  "doi",
  "locator_kind",
  "locator_value",
  "review_state",
  "document_kind",
  // capture / enrichment state
  "source_enriched",
  // memory digests (memory/note.ts)
  "session_id",
  "claude-session",
]);

const RESEARCH_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "project", "source", "source_kind", "canonical_id", "source_fingerprint", "content_fingerprint", "discovery_provenance",
  "zotero_key", "arxiv_id", "doi", "locator_kind", "locator_value", "review_state", "document_kind",
]);

function managedKeyError(key: string): Error {
  return new Error(RESEARCH_RESERVED_KEYS.has(key)
    ? `Frontmatter key "${key}" is managed by Companion. ${RESEARCH_ROUTE_HINT}`
    : `Frontmatter key "${key}" is managed by Companion and cannot be set through this tool.`);
}

/** Guard the generic frontmatter writers against clobbering machine-owned keys. */
function assertWritableFrontmatterKey(key: string): void {
  if (RESERVED_FRONTMATTER_KEYS.has(key)) throw managedKeyError(key);
}
/** Reserved keys whose value differs between two note contents. */
function changedReservedKeys(oldContent: string, newContent: string): { keys: string[]; newFm: Record<string, unknown> } {
  const oldFm = readFrontmatter(oldContent, (yaml) => parseYaml(yaml) as unknown) ?? {};
  const newFm = readFrontmatter(newContent, (yaml) => parseYaml(yaml) as unknown) ?? {};
  return { keys: [...RESERVED_FRONTMATTER_KEYS].filter((key) => JSON.stringify(oldFm[key]) !== JSON.stringify(newFm[key])), newFm };
}
/** Narrow a conformance-fixed record to buildFrontmatter's value types; anything else is dropped. */
function toFrontmatterData(record: Record<string, unknown>): FrontmatterData {
  const out: FrontmatterData = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((x): x is string => typeof x === "string")) out[key] = value;
  }
  return out;
}
function splitTagList(content: string): string[] {
  return content.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Array.isArray narrows to any[]; this keeps the narrowed elements unknown. */
function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export class NoteTools {
  constructor(
    private app: App,
    private opts: VaultToolsOptions,
    private researchRepository: () => ResearchRepository,
  ) {}

  records(): ToolRecord[] {
    const opts = this.opts;
    return [
      read({
        name: "note_read",
        description: "Read the full Markdown content of a note by its vault path (e.g. 'Folder/Note.md').",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
        outputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      }, async (args) => this.read(str(args.path))),
      {
        // The typed-creation fields follow the registry's contents at listing time.
        get def(): McpToolDef {
          return {
            name: "note_create",
            description: "Create a new Markdown note. Adds YAML frontmatter (title, tags, source) for correct indexing.",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Note title (also used for the filename)." },
                content: { type: "string", description: "Markdown body." },
                folder: { type: "string", description: "Target folder (defaults to the configured folder)." },
                tags: { type: "array", items: { type: "string" }, description: "Tags to apply." },
                ...((opts.ontology?.()?.resolved().size ?? 0) > 0
                  ? {
                      type: { type: "string", description: "Ontology type for this note (e.g. person, project, concept; unknown types are reported back with the available list)." },
                      properties: { type: "object", description: "Type-specific frontmatter properties and relation fields (relations are lists of \"[[wikilink]]\" strings)." },
                    }
                  : {}),
              },
              required: ["title", "content"],
            },
          };
        },
        writes: true,
        run: async (args) => this.create(str(args.title), str(args.content), optStr(args.folder), strArray(args.tags), optStr(args.type), optObj(args.properties)),
      },
      write(
        {
          name: "note_append",
          description: "Append Markdown text to an existing note (creates it if missing).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              content: { type: "string", description: "Markdown to append." },
            },
            required: ["path", "content"],
          },
        },
        async (args) => this.append(str(args.path), str(args.content)),
      ),
      write(
        {
          name: "note_update",
          description: "Replace a note's content in place — the whole body, or one named '## section' if 'section' is given. Overwrites; not append. Companion-managed frontmatter keys cannot be changed this way.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              content: { type: "string", description: "New content for the note (or for the section)." },
              section: { type: "string", description: "Optional heading text; replace only that section's body." },
            },
            required: ["path", "content"],
          },
        },
        async (args) => this.update(str(args.path), str(args.content), optStr(args.section)),
      ),
      write(
        {
          name: "note_patch",
          description: "Insert or replace Markdown at one place in a note: a heading's section, a block referenced by ^id, a frontmatter key, or the whole document. 'replace' swaps the target; 'append'/'prepend' insert after/before it. Prefer this over note_update for targeted changes.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              target: {
                type: "object",
                description: "Where to patch.",
                properties: {
                  kind: { type: "string", enum: ["heading", "block", "frontmatter", "document"] },
                  heading: { type: "string", description: "Heading text (kind=heading)." },
                  id: { type: "string", description: "Block id, with or without the caret (kind=block)." },
                  key: { type: "string", description: "Frontmatter key (kind=frontmatter)." },
                },
                required: ["kind"],
              },
              op: { type: "string", enum: ["replace", "append", "prepend"] },
              content: { type: "string", description: "Markdown to insert, or the frontmatter value (a list item for append/prepend on a list key)." },
            },
            required: ["path", "target", "op", "content"],
          },
        },
        async (args) => this.patch(str(args.path), args.target, str(args.op), str(args.content)),
      ),
      write(
        {
          name: "update_frontmatter",
          description: "Merge YAML frontmatter into a note. 'tags' are unioned and normalized; other keys are set. Preserves the note body. Companion-managed keys (type, type_name, ontology, source_kind, canonical_id, content_fingerprint, discovery_provenance, zotero_key, arxiv_id, doi, locator_value, source_enriched, session_id) are reserved and rejected.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              tags: { type: "array", items: { type: "string" }, description: "Tags to add (unioned with existing)." },
              fields: { type: "object", description: "Other scalar frontmatter fields to set (e.g. {type:'note'})." },
            },
            required: ["path"],
          },
        },
        async (args) => this.updateFrontmatter(str(args.path), strArray(args.tags), args.fields),
      ),
      write(
        {
          name: "note_move",
          description: "Move or rename a note to a new vault path. Backlinks to it are rewritten automatically. Provide the full destination path (including filename).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Current vault-relative path of the note." },
              to: { type: "string", description: "Destination vault-relative path (folder and filename)." },
            },
            required: ["path", "to"],
          },
        },
        async (args) => this.move(str(args.path), str(args.to)),
      ),
    ];
  }

  private async read(path: string): Promise<ToolOutput> {
    const file = resolveFile(this.app, path);
    const content = await this.app.vault.cachedRead(file);
    return { text: content, structured: { path: file.path, content } };
  }

  private resolveAgentTags(raw: string[]): { tags: string[]; note: string } {
    if (raw.length === 0) return { tags: [], note: "" };
    const resolve = createTagResolver(vaultVocabulary(this.app));
    const resolved = raw.map(resolve).filter((r): r is ResolvedTag => r !== null);
    const mapped = new Map<string, ResolvedTag>();
    for (const r of resolved) if (r.match === "variant" && !mapped.has(r.input)) mapped.set(r.input, r);
    return {
      tags: [...new Set(resolved.map((r) => r.tag))],
      note: mapped.size > 0 ? `\nTags mapped to existing: ${[...mapped.values()].map((r) => `${r.input} → ${r.tag}`).join(", ")}` : "",
    };
  }

  private async create(
    title: string,
    content: string,
    folder: string | undefined,
    rawTags: string[],
    typeName?: string,
    properties?: Record<string, unknown>,
  ): Promise<string> {
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await ensureFolder(this.app, dir);
    const { tags, note: mappedNote } = this.resolveAgentTags(rawTags);
    const base: FrontmatterData = {
      title,
      created: new Date().toISOString().slice(0, 10),
      source: "claude-mcp",
      tags: normalizeTags(["claude", ...tags]),
    };
    let data: FrontmatterData = base;
    let conformance = "";
    const registry = this.opts.ontology?.() ?? null;
    // An enabled-but-empty registry (never seeded) behaves like no ontology.
    if (registry && registry.resolved().size > 0 && typeName) {
      const resolved = registry.resolve(typeName);
      // Base keys + the validated type always win over model-supplied properties.
      const safeProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(properties ?? {})) if (!PROTECTED_KEYS.has(k)) safeProps[k] = v;
      const merged: Record<string, unknown> = { ...base, type: typeName, ...safeProps };
      const r = conform(merged, resolved, (target) => lookupRelationTargetType(this.app, registry, target));
      // Unknown type: fall back to the untyped legacy frontmatter — advisory, never blocking.
      data = resolved ? toFrontmatterData(r.fixed) : base;
      if (r.issues.length > 0) {
        const messages = r.issues.map((i) =>
          i.kind === "unknown-type" ? `${i.message} — available: ${[...registry.resolved().keys()].join(", ")}` : i.message,
        );
        conformance = `\nConformance: ${messages.join("; ")}`;
      }
    }
    const body = `${buildFrontmatter(data)}\n\n# ${title}\n\n${content}\n`;
    const path = await uniquePath(this.app, dir, title);
    const file = await this.app.vault.create(path, body);
    return `Created note: ${file.path}${conformance}${mappedNote}`;
  }

  /** Advisory conformance of a typed note after a write; empty when nothing applies. */
  private async conformanceLine(file: TFile): Promise<string> {
    const registry = this.opts.ontology?.() ?? null;
    if (!registry || registry.resolved().size === 0) return "";
    let fm: Record<string, unknown> | null;
    try {
      // The metadata cache updates asynchronously; the file on disk is already written.
      fm = readFrontmatter(await this.app.vault.read(file), (yaml) => parseYaml(yaml) as unknown);
    } catch (e) {
      console.debug("Claude Companion: conformance frontmatter read failed", e);
      return "";
    }
    if (!fm || typeof fm.type !== "string") return "";
    const r = conform(fm, registry.resolve(fm.type), (target) => lookupRelationTargetType(this.app, registry, target));
    if (r.issues.length === 0) return "\nConformance: ok";
    return `\nConformance: ${r.issues.length} issue(s): ${r.issues.map((i) => i.message).join("; ")}`;
  }

  private async append(path: string, content: string): Promise<string> {
    const p = assertVaultPath(path);
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, `\n${content}\n`);
      return `Appended to: ${existing.path}${await this.conformanceLine(existing)}`;
    }
    const file = await this.app.vault.create(p, `${content}\n`);
    return `Created and wrote: ${file.path}`;
  }

  private async update(path: string, content: string, section: string | undefined): Promise<string> {
    const file = resolveFile(this.app, path);
    if (section) {
      const current = await this.app.vault.cachedRead(file);
      const next = replaceSection(current, section, content);
      await this.app.vault.modify(file, next);
      return `Updated section "${section}" in ${file.path}${await this.conformanceLine(file)}`;
    }
    const current = await this.app.vault.cachedRead(file);
    const { keys: changed, newFm } = changedReservedKeys(current, content);
    let plan: ResearchRoutePlan | undefined;
    if (changed.length) {
      const blocked = changed.find((key) => !DELEGABLE_RESEARCH_KEYS.has(key));
      if (blocked) throw managedKeyError(blocked);
      const removed = changed.find((key) => newFm[key] === undefined);
      if (removed) throw managedKeyError(removed);
      const values: Record<string, unknown> = {};
      for (const key of changed) values[key] = newFm[key];
      if (changed.some((key) => key.startsWith("locator_"))) for (const key of ["locator_kind", "locator_value"]) if (newFm[key] !== undefined) values[key] = newFm[key];
      plan = planResearchRouting(await this.researchRecordOf(file), values);
    }
    await this.app.vault.modify(file, content);
    if (plan) await runResearchRouting(this.researchRepository(), plan);
    return `${plan ? `${plan.summaries.join(" ")} ` : ""}Updated ${file.path}${await this.conformanceLine(file)}`;
  }

  private async patch(path: string, target: unknown, op: string, content: string): Promise<string> {
    const file = resolveFile(this.app, path);
    if (op !== "replace" && op !== "append" && op !== "prepend") throw new Error(`Unknown op: ${op}`);
    const t = (target && typeof target === "object" ? target : {}) as { kind?: unknown; heading?: unknown; id?: unknown; key?: unknown };
    if (t.kind === "frontmatter") {
      const key = str(t.key);
      if (DELEGABLE_RESEARCH_KEYS.has(key)) {
        if (op !== "replace") throw managedKeyError(key);
        const plan = planResearchRouting(await this.researchRecordOf(file), { [key]: content });
        await runResearchRouting(this.researchRepository(), plan);
        return plan.summaries.join(" ");
      }
      assertWritableFrontmatterKey(key);
      if (key === "tags") {
        const { tags, note } = this.resolveAgentTags(splitTagList(content));
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          const existing: unknown[] = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? [fm.tags] : [];
          const present = new Set(existing.map(String));
          const added = tags.filter((tag) => !present.has(tag));
          fm.tags = op === "replace" ? tags : op === "append" ? [...existing, ...added] : [...added, ...existing];
        });
        return `Patched frontmatter "tags" of ${file.path} (${op})${await this.conformanceLine(file)}${note}`;
      }
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (op === "replace") {
          fm[key] = content;
          return;
        }
        const existing = fm[key];
        if (existing !== undefined && !isUnknownArray(existing)) throw new Error(`Frontmatter key "${key}" is not a list; use op "replace".`);
        const list = isUnknownArray(existing) ? [...existing] : [];
        fm[key] = op === "append" ? [...list, content] : [content, ...list];
      });
      return `Patched frontmatter "${key}" of ${file.path} (${op})${await this.conformanceLine(file)}`;
    }
    const patchTarget: PatchTarget | null =
      t.kind === "heading" ? { kind: "heading", heading: str(t.heading) }
      : t.kind === "block" ? { kind: "block", id: str(t.id).replace(/^\^/, "") }
      : t.kind === "document" ? { kind: "document" }
      : null;
    if (!patchTarget) throw new Error(`Unknown target kind: ${String(t.kind)}`);
    const current = await this.app.vault.cachedRead(file);
    await this.app.vault.modify(file, applyPatch(current, { target: patchTarget, op, content }));
    const where = patchTarget.kind === "heading" ? `section "${patchTarget.heading}"` : patchTarget.kind === "block" ? `block ^${patchTarget.id}` : "the document";
    return `Patched ${where} in ${file.path} (${op})${await this.conformanceLine(file)}`;
  }

  private async updateFrontmatter(path: string, rawTags: string[], fields: unknown): Promise<string> {
    const file = resolveFile(this.app, path);
    const scalars: Record<string, string | number | boolean> = {};
    const fieldTags: string[] = [];
    if (fields && typeof fields === "object") {
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        if (k === "tags") {
          if (typeof v === "string") fieldTags.push(...splitTagList(v));
          else if (isUnknownArray(v)) fieldTags.push(...v.filter((i): i is string => typeof i === "string"));
        } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") scalars[k] = v;
      }
    }
    const { tags, note: mappedNote } = this.resolveAgentTags([...rawTags, ...fieldTags]);
    const delegated: Record<string, unknown> = {};
    for (const k of Object.keys(scalars)) {
      if (DELEGABLE_RESEARCH_KEYS.has(k)) { delegated[k] = scalars[k]; delete scalars[k]; }
      else assertWritableFrontmatterKey(k);
    }
    const plan = Object.keys(delegated).length ? planResearchRouting(await this.researchRecordOf(file), delegated) : undefined;
    if (plan) {
      await runResearchRouting(this.researchRepository(), plan);
      if (!tags.length && !Object.keys(scalars).length) return plan.summaries.join(" ");
    }
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (tags.length) {
        const existing = Array.isArray(fm.tags)
          ? (fm.tags as unknown[]).map(String)
          : typeof fm.tags === "string"
            ? [fm.tags]
            : [];
        fm.tags = normalizeTags([...existing, ...tags]);
      }
      for (const [k, v] of Object.entries(scalars)) fm[k] = v;
    });
    return `${plan ? `${plan.summaries.join(" ")} ` : ""}Updated frontmatter of ${file.path}${await this.conformanceLine(file)}${mappedNote}`;
  }

  private async researchRecordOf(file: TFile): Promise<ResearchRecord | undefined> {
    const content = await this.app.vault.cachedRead(file);
    const frontmatter = readFrontmatter(content, (yaml) => parseYaml(yaml) as unknown);
    if (!frontmatter) return undefined;
    return parseResearchRecord({ path: file.path, frontmatter, body: stripFrontmatter(content) }).record;
  }

  private async move(path: string, to: string): Promise<string> {
    const file = resolveFile(this.app, path);
    const dest = assertVaultPath(to);
    await this.app.fileManager.renameFile(file, dest);
    return `Moved ${path} → ${dest} (backlinks updated)`;
  }
}
