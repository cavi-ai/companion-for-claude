// Pure chat-project model: parse a project note, derive one from a Research
// Desk project, and render its system-prompt addendum / search scope.

import type { ResearchProjectRecord } from "../research/types";
import { projectFolderOf } from "../research/repository";

export interface ChatProject {
  /** Note path (chat-project note) or research Project.md path. */
  id: string;
  name: string;
  folder: string | null;
  pinned: string[];
  instructions: string;
  source: "note" | "research";
}

const PROJECT_TYPE = "chat-project";

/** Strip a `[[Note]]` / `[[Note|Alias]]` wrapper and normalize to a `.md` path. */
function stripWikilink(raw: string): string {
  const trimmed = raw.trim();
  const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
  const inner = (match?.[1] ?? trimmed).trim();
  return inner.toLowerCase().endsWith(".md") ? inner : `${inner}.md`;
}

function pinnedList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(stripWikilink);
}

/** True when frontmatter marks a note as a chat project. */
export function isProjectNote(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.type === PROJECT_TYPE;
}

/** True when a note change (this path/frontmatter) could affect the chat-project list. */
export function isProjectChange(path: string, frontmatter?: Record<string, unknown>): boolean {
  return isProjectNote(frontmatter) || projectFolderOf(path) !== null;
}

/** Parse a chat-project note: frontmatter `type: chat-project`, optional `folder`/`pinned`, body = instructions. */
export function parseProjectNote(path: string, frontmatter: Record<string, unknown> | undefined, body: string): ChatProject | null {
  if (!isProjectNote(frontmatter)) return null;
  const base = path.split("/").pop() ?? path;
  const name = base.replace(/\.md$/i, "");
  const rawFolder = frontmatter?.folder;
  const folder = typeof rawFolder === "string" && rawFolder.trim() ? rawFolder.trim().replace(/\/$/, "") : null;
  return { id: path, name, folder, pinned: pinnedList(frontmatter?.pinned), instructions: body.trim(), source: "note" };
}

/** Map a Research Desk project to a chat project: its folder scopes context, its question is the instructions. */
export function fromResearchProject(record: ResearchProjectRecord): ChatProject {
  return { id: record.path, name: record.title, folder: projectFolderOf(record.path), pinned: [], instructions: record.question, source: "research" };
}

/** The system-prompt addendum for an active chat project: header, instructions, pinned notes. */
export function projectSystemPrompt(project: ChatProject): string {
  const lines = [`Chat project: ${project.name}`, project.instructions];
  if (project.pinned.length > 0) lines.push(`Pinned notes:\n${project.pinned.map((p) => `- ${p}`).join("\n")}`);
  return lines.join("\n\n");
}

/** Frontmatter + empty body for a new chat-project note; a null/root folder omits `folder`. */
export function projectNoteBody(folder: string | null): string {
  const normalized = folder && folder !== "/" ? folder : null;
  const frontmatter = `type: chat-project${normalized ? `\nfolder: ${JSON.stringify(normalized)}` : ""}`;
  return `---\n${frontmatter}\n---\n\n`;
}

/** A vault-search accept predicate scoped to the project's folder (no folder = unscoped). */
export function projectSearchScope(project: ChatProject): (path: string) => boolean {
  const folder = project.folder;
  if (!folder) return () => true;
  const prefix = `${folder}/`;
  return (path: string) => path.startsWith(prefix);
}
