import { TFile, type App } from "obsidian";
import { tagId } from "../tags/vocabulary";
import { ensureVaultFolder, uniqueNotePath } from "../vault/vaultFiles";
import type { ResolvedType } from "../ontology/types";
import type { RelatedWrite } from "./linkController";
import { mergeRelated } from "./linkPlan";
import type { LinkScanNote } from "./linkScan";
import { entryId, mapTagList, OPTIMIZE_OUTPUT_ROOT, rewriteInlineTags, type NoteMergePlan, type NoteTagInput } from "./mergePlan";

const TAG_KEY = /^tags?$/i;

function tagValues(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return null;
}

function markdownFile(app: App, path: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

export function noteTagInput(app: App, path: string): NoteTagInput | null {
  const file = markdownFile(app, path);
  if (!file) return null;
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter as Record<string, unknown> | undefined;
  const frontmatterTags: string[] = [];
  for (const [key, value] of Object.entries(fm ?? {})) if (TAG_KEY.test(key)) frontmatterTags.push(...(tagValues(value) ?? []));
  const inline: NoteTagInput["inline"] = [];
  for (const t of cache?.tags ?? []) {
    if (!t.position) continue;
    inline.push({ tag: t.tag.replace(/^#/, ""), start: t.position.start.offset, end: t.position.end.offset });
  }
  return { path, frontmatterTags, inline };
}

export interface NoteMergeResult {
  inlineApplied: number;
  inlineSkipped: number;
  changed: string[];
}

export async function applyNoteMerge(
  app: App,
  plan: NoteMergePlan,
  map: ReadonlyMap<string, string>,
): Promise<NoteMergeResult> {
  const file = markdownFile(app, plan.path);
  if (!file) throw new Error(`Note not found: ${plan.path}`);
  const changed = new Set<string>();
  let inlineApplied = 0;
  let inlineSkipped = 0;
  if (plan.inline.length > 0) {
    await app.vault.process(file, (content) => {
      const result = rewriteInlineTags(content, plan.inline);
      inlineApplied = result.applied;
      inlineSkipped = result.skipped;
      for (const from of result.appliedFrom) changed.add(from);
      return result.content;
    });
  }
  if (plan.before.some((t) => map.has(tagId(t)))) {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      for (const key of Object.keys(fm)) {
        if (!TAG_KEY.test(key)) continue;
        const current = fm[key];
        const entries = Array.isArray(current) ? current : typeof current === "string" ? current.split(/[\s,]+/).filter(Boolean) : null;
        if (!entries) continue;
        const mapped = mapTagList(entries, map);
        if (!mapped.changed) continue;
        fm[key] = Array.isArray(current) ? mapped.tags : mapped.tags.join(", ");
        for (const entry of entries) {
          const id = entryId(entry);
          if (id !== null && map.has(id)) changed.add(id);
        }
      }
    });
  }
  return { inlineApplied, inlineSkipped, changed: [...changed] };
}

export async function writeOptimizeRunNote(app: App, content: string, now: string, title = "Tag merges"): Promise<string> {
  await ensureVaultFolder(app, OPTIMIZE_OUTPUT_ROOT);
  const stamp = now.slice(0, 16).replace("T", " ").replace(":", "");
  const path = await uniqueNotePath(app, OPTIMIZE_OUTPUT_ROOT, `${title} ${stamp}`, "md");
  await app.vault.create(path, content);
  return path;
}

export interface RelationRegistry {
  resolve(name: string): ResolvedType | undefined;
  resolved(): ReadonlyMap<string, ResolvedType>;
}

/** Whether `conform` would accept a `related` key on a note of this type. */
export function acceptsRelated(type: string | undefined, registry: RelationRegistry | null): boolean {
  if (type === undefined || !registry || registry.resolved().size === 0) return true;
  return registry.resolve(type)?.relations.some((r) => r.key === "related") ?? false;
}

export function linkScanNotes(app: App, registry: RelationRegistry | null): LinkScanNote[] {
  return app.vault.getMarkdownFiles().map((f) => {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    const raw = fm?.aliases;
    const aliases = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw.trim() ? [raw] : [];
    const type = typeof fm?.type === "string" ? fm.type : undefined;
    return { path: f.path, basename: f.basename, aliases, mtime: f.stat.mtime, ...(type !== undefined ? { type } : {}), acceptsRelated: acceptsRelated(type, registry) };
  });
}

export async function processNoteBody(app: App, path: string, transform: (current: string) => string): Promise<void> {
  const file = markdownFile(app, path);
  if (!file) throw new Error(`Note not found: ${path}`);
  await app.vault.process(file, transform);
}

export async function addRelatedLinks(app: App, path: string, entries: string[]): Promise<RelatedWrite> {
  const file = markdownFile(app, path);
  if (!file) throw new Error(`Note not found: ${path}`);
  let result: RelatedWrite = { ok: true, added: [] };
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const merged = mergeRelated(fm.related, entries);
    if (!merged.ok) {
      result = merged;
      return;
    }
    result = { ok: true, added: merged.added };
    if (merged.added.length > 0) fm.related = merged.value;
  });
  return result;
}
