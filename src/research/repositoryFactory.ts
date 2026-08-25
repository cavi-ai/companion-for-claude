// The one place a ResearchRepository gets wired to a live vault. Both the
// in-app research views (main.ts) and the MCP vault tools used to hand-roll
// this ~35-line factory each — same readNotes, same folder prefixes, same IO.
// Callers differ only in write-path policy (the MCP surface asserts paths) and
// whether binary reads are exposed.

import { App, TFile, normalizePath, parseYaml } from "obsidian";
import { ResearchRepository } from "./repository";
import type { ResearchNoteInput } from "./parse";

export interface ResearchRepositoryFactoryOptions {
  /** Create missing parent folders before createWithParents writes. */
  ensureFolder: (folder: string) => Promise<void>;
  /** Write-path normalizer: normalizePath in-app, assertVaultPath on the MCP surface. */
  normalizeWritePath?: (path: string) => string;
  /** Expose readBinary for current source-asset fingerprints. */
  includeBinary?: boolean;
  /** Refuse unexpectedly large binary reads before allocating renderer memory. */
  maxBinaryBytes?: number;
}

export const DEFAULT_MAX_RESEARCH_BINARY_BYTES = 25 * 1024 * 1024;

/** Folders (under a project) that hold research records. */
const PROJECT_PREFIXES = ["Sources", "Evidence", "Claims", "Questions", "Documents"];

export function createResearchRepository(app: App, opts: ResearchRepositoryFactoryOptions): ResearchRepository {
  const normalizeWrite = opts.normalizeWritePath ?? ((p: string) => normalizePath(p));

  const readNotes = async (files: TFile[]): Promise<ResearchNoteInput[]> =>
    Promise.all(
      files.map(async (file) => {
        const content = await app.vault.cachedRead(file);
        const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
        const cached = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
        const frontmatter = cached ?? (match ? (parseYaml(match[1] ?? "") as Record<string, unknown>) : undefined);
        return { path: file.path, ...(frontmatter ? { frontmatter } : {}), body };
      }),
    );

  return new ResearchRepository({
    listMarkdown: () => readNotes(app.vault.getMarkdownFiles()),
    listProjectMarkdown: (projectPath) => {
      const folder = projectPath.slice(0, -"/Project.md".length);
      const prefixes = PROJECT_PREFIXES.map((name) => `${folder}/${name}/`);
      return readNotes(app.vault.getMarkdownFiles().filter((file) => file.path === projectPath || prefixes.some((prefix) => file.path.startsWith(prefix))));
    },
    createWithParents: async (path, content) => {
      const normalized = normalizeWrite(path);
      if (app.vault.getAbstractFileByPath(normalized)) throw new Error(`File already exists: ${normalized}`);
      await opts.ensureFolder(normalized.slice(0, normalized.lastIndexOf("/")));
      await app.vault.create(normalized, content);
    },
    updateFrontmatter: async (path, mutator) => {
      const file = app.vault.getAbstractFileByPath(normalizeWrite(path));
      if (!(file instanceof TFile)) throw new Error(`Research note not found: ${path}`);
      await app.fileManager.processFrontMatter(file, mutator);
    },
    updateText: async (path, updater) => {
      const file = app.vault.getAbstractFileByPath(normalizeWrite(path));
      if (!(file instanceof TFile)) throw new Error(`Research note not found: ${path}`);
      await app.vault.process(file, updater);
    },
    ...(opts.includeBinary
      ? {
          readBinary: async (path: string) => {
            const file = app.vault.getAbstractFileByPath(normalizePath(path));
            if (!(file instanceof TFile)) throw new Error(`Research source asset not found: ${path}`);
            const limit = opts.maxBinaryBytes ?? DEFAULT_MAX_RESEARCH_BINARY_BYTES;
            if (file.stat.size > limit) throw new Error(`Research source asset exceeds the ${Math.floor(limit / (1024 * 1024))} MiB fingerprint limit: ${path}`);
            return new Uint8Array(await app.vault.readBinary(file));
          },
        }
      : {}),
  }, app);
}
