import { App, Notice, TFile, normalizePath } from "obsidian";
import { sanitizeFileName, type ExtractedArtifact } from "./parse";
import { buildFrontmatter, normalizeTags, datedTitleBase } from "../indexing/frontmatter";

export { extractArtifact, type ExtractedArtifact } from "./parse";

async function ensureFolder(app: App, folder: string): Promise<void> {
  const path = normalizePath(folder);
  if (path === "" || path === "/") return;
  if (app.vault.getAbstractFileByPath(path)) return;
  // Create nested folders segment by segment.
  const parts = path.split("/");
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        /* race: already exists */
      }
    }
  }
}

async function writeUnique(app: App, folder: string, base: string, ext: string, content: string): Promise<TFile> {
  await ensureFolder(app, folder);
  const safe = sanitizeFileName(base);
  let path = normalizePath(`${folder}/${safe}.${ext}`);
  let i = 2;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${folder}/${safe} ${i}.${ext}`);
    i++;
  }
  return app.vault.create(path, content);
}

/**
 * Save an HTML artifact as a markdown note that renders inline via the
 * `claude-html` code-block processor. This keeps the artifact portable,
 * editable, and previewable inside the vault.
 */
export interface SaveOptions {
  height: number;
  /** Base tags always applied (e.g. ["claude","artifact"]). */
  baseTags: string[];
  /** Extra tags (e.g. auto-generated). */
  extraTags?: string[];
  /** Optional one-line summary for frontmatter + search. */
  summary?: string;
}

export async function saveArtifactNote(app: App, folder: string, artifact: ExtractedArtifact, opts: SaveOptions): Promise<TFile> {
  const created = new Date().toISOString().slice(0, 10);
  const fm = buildFrontmatter({
    title: artifact.title,
    created,
    source: "claude-companion",
    type: "artifact",
    summary: opts.summary,
    tags: normalizeTags([...opts.baseTags, ...(opts.extraTags ?? [])]),
  });
  const note = [fm, "", `# ${artifact.title}`, "", "```claude-html height=" + opts.height, artifact.html, "```", ""].join("\n");
  const file = await writeUnique(app, folder, datedTitleBase(created, artifact.title), "md", note);
  new Notice(`Saved artifact → ${file.path}`);
  return file;
}

/**
 * Save a generated plan as a `type: plan` note: the reply markdown (its inline
 * `claude-html` artifact + the `## Build tasks` checklist) verbatim, so it renders
 * beautifully AND the Build command can parse its checklist. The frontmatter type
 * makes the note "canonical" — it gets the Build header icon.
 */
export async function savePlanNote(app: App, folder: string, title: string, markdown: string, opts?: Partial<SaveOptions>): Promise<TFile> {
  const created = new Date().toISOString().slice(0, 10);
  const fm = buildFrontmatter({
    title,
    created,
    source: "claude-companion",
    type: "plan",
    summary: opts?.summary,
    tags: normalizeTags([...(opts?.baseTags ?? ["claude", "plan"]), ...(opts?.extraTags ?? [])]),
  });
  const note = [fm, "", `# ${title}`, "", markdown, ""].join("\n");
  const file = await writeUnique(app, folder, datedTitleBase(created, title), "md", note);
  new Notice(`Saved plan → ${file.path}`);
  return file;
}

/** Save a chat transcript as a markdown note. */
export async function saveChatNote(app: App, folder: string, title: string, markdown: string, opts?: Partial<SaveOptions>): Promise<TFile> {
  const created = new Date().toISOString().slice(0, 10);
  const fm = buildFrontmatter({
    title,
    created,
    source: "claude-companion",
    type: "chat",
    summary: opts?.summary,
    tags: normalizeTags([...(opts?.baseTags ?? ["claude", "chat"]), ...(opts?.extraTags ?? [])]),
  });
  const note = [fm, "", `# ${title}`, "", markdown, ""].join("\n");
  const file = await writeUnique(app, folder, datedTitleBase(created, title), "md", note);
  new Notice(`Saved chat → ${file.path}`);
  return file;
}
