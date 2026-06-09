// Minimal in-memory fake of the Obsidian API surface used by the plugin's
// testable modules (currently src/mcp/vaultTools.ts). Vitest aliases the
// "obsidian" import to this file so we can exercise VaultTools against a real
// vault without launching Obsidian.
//
// Only the pieces the code under test actually touches are implemented; if a
// new dependency on the Obsidian API appears, add it here.

import { buildFrontmatter, type FrontmatterData } from "../../src/indexing/frontmatter";

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export const Platform = { isMobile: false, isDesktop: true };

export class TFile {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number; ctime: number; size: number };
  /** internal content store (not part of the real Obsidian API) */
  _content: string;

  constructor(path: string, content: string, mtime: number) {
    this.path = path;
    this._content = content;
    this.stat = { mtime, ctime: mtime, size: content.length };
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    this.extension = dot > 0 ? name.slice(dot + 1) : "";
    this.basename = dot > 0 ? name.slice(0, dot) : name;
  }
}

export class TFolder {
  constructor(public path: string) {}
}

interface FileCache {
  tags?: Array<{ tag: string }>;
  frontmatter?: Record<string, unknown>;
}

/** Mirrors Obsidian's getAllTags(cache): returns "#tag" strings or null. */
export function getAllTags(cache: FileCache | null): string[] | null {
  if (!cache) return null;
  const out: string[] = [];
  for (const t of cache.tags ?? []) out.push(t.tag);
  const fm = cache.frontmatter?.tags;
  if (Array.isArray(fm)) for (const t of fm) out.push(String(t).startsWith("#") ? String(t) : `#${t}`);
  return out;
}

class FakeVault {
  private files = new Map<string, TFile>();
  private folders = new Set<string>();
  /** path -> tag strings (without #), used to build the metadata cache */
  tags = new Map<string, string[]>();
  /** path -> frontmatter object */
  frontmatters = new Map<string, Record<string, unknown>>();

  /** Test helper: seed a note. */
  seed(path: string, content: string, opts: { mtime?: number; tags?: string[]; frontmatter?: Record<string, unknown> } = {}): TFile {
    const p = normalizePath(path);
    const file = new TFile(p, content, opts.mtime ?? Date.now());
    this.files.set(p, file);
    if (opts.tags?.length) this.tags.set(p, opts.tags);
    if (opts.frontmatter) this.frontmatters.set(p, opts.frontmatter);
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (dir) this.folders.add(dir);
    return file;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => f.extension === "md");
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const p = normalizePath(path);
    const f = this.files.get(p);
    if (f) return f;
    if (this.folders.has(p)) return new TFolder(p);
    return null;
  }

  cachedRead(file: TFile): Promise<string> {
    return Promise.resolve(file._content);
  }

  createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
    return Promise.resolve();
  }

  create(path: string, content: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error(`File already exists: ${p}`);
    const file = new TFile(p, content, Date.now());
    this.files.set(p, file);
    return Promise.resolve(file);
  }

  append(file: TFile, content: string): Promise<void> {
    file._content += content;
    file.stat.size = file._content.length;
    return Promise.resolve();
  }

  modify(file: TFile, content: string): Promise<void> {
    file._content = content;
    file.stat.size = content.length;
    return Promise.resolve();
  }

  /** Test helper used by FakeFileManager.renameFile. */
  _moveFile(file: TFile, newPath: string): void {
    this.files.delete(file.path);
    file.path = newPath;
    const name = newPath.split("/").pop() ?? newPath;
    const dot = name.lastIndexOf(".");
    file.basename = dot > 0 ? name.slice(0, dot) : name;
    this.files.set(newPath, file);
    const dir = newPath.includes("/") ? newPath.slice(0, newPath.lastIndexOf("/")) : "";
    if (dir) this.folders.add(dir);
  }
}

class FakeMetadataCache {
  resolvedLinks: Record<string, Record<string, number>> = {};
  constructor(private vault: FakeVault) {}
  getFileCache(file: TFile): FileCache | null {
    const tags = this.vault.tags.get(file.path);
    const frontmatter = this.vault.frontmatters.get(file.path);
    if (!tags && !frontmatter) return null;
    const cache: FileCache = {};
    if (tags) cache.tags = tags.map((t) => ({ tag: t.startsWith("#") ? t : `#${t}` }));
    if (frontmatter) cache.frontmatter = frontmatter;
    return cache;
  }
}

/**
 * Minimal fake of Obsidian's FileManager. Only `processFrontMatter` is needed.
 * Parses the leading `---...---` block of the file into a plain object (simple
 * `key: value` scalars + `tags:` list shape — enough to exercise OUR callback
 * logic, not Obsidian's full YAML engine), runs the callback to mutate it, then
 * re-serializes via the production `buildFrontmatter` and rejoins with the body.
 */
class FakeFileManager {
  constructor(private vault: FakeVault) {}

  renameFile(file: TFile, newPath: string): Promise<void> {
    const p = normalizePath(newPath);
    this.vault._moveFile(file, p);
    return Promise.resolve();
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(file._content);
    const obj: Record<string, unknown> = {};
    let body = file._content;
    if (m) {
      const fmLines = m[1].split("\n");
      for (let i = 0; i < fmLines.length; i++) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(fmLines[i]);
        if (!kv) continue;
        const key = kv[1];
        const rest = kv[2].trim();
        if (rest === "" || rest === "[]") {
          const items: string[] = [];
          while (i + 1 < fmLines.length && /^\s*-\s+/.test(fmLines[i + 1])) {
            items.push(fmLines[++i].replace(/^\s*-\s+/, "").trim().replace(/^"(.*)"$/, "$1"));
          }
          obj[key] = items;
        } else {
          obj[key] = rest.replace(/^"(.*)"$/, "$1");
        }
      }
      body = file._content.slice(m[0].length).replace(/^\n+/, "");
    }
    fn(obj);
    file._content = `${buildFrontmatter(obj as FrontmatterData)}\n\n${body}`;
    file.stat.size = file._content.length;
    return Promise.resolve();
  }
}

export class App {
  vault = new FakeVault();
  metadataCache = new FakeMetadataCache(this.vault);
  fileManager = new FakeFileManager(this.vault);
}

// Value stubs for modules that import these names (not exercised in tests).
export class Notice {
  constructor(public message: string) {}
}
export class Plugin {}
export class MarkdownView {}
export class WorkspaceLeaf {}
