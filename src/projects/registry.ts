// Chat-project registry: every `type: chat-project` note plus Research Desk
// projects, merged into one list. A research project whose folder equals a
// chat-project note's folder is dropped — the note wins.

import type { App } from "obsidian";
import type { ResearchRepository } from "../research/repository";
import { parseProjectNote, fromResearchProject, type ChatProject } from "./model";

function stripFrontmatterBlock(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

/** Every chat project available in this vault, note projects first. */
export async function listChatProjects(app: App, research: ResearchRepository | null): Promise<ChatProject[]> {
  const notes: ChatProject[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    if (frontmatter?.type !== "chat-project") continue;
    const content = await app.vault.cachedRead(file);
    const project = parseProjectNote(file.path, frontmatter, stripFrontmatterBlock(content));
    if (project) notes.push(project);
  }
  const noteFolders = new Set(notes.map((p) => p.folder).filter((f): f is string => f !== null));
  const researchProjects = research
    ? (await research.listProjects()).map(fromResearchProject).filter((p) => p.folder === null || !noteFolders.has(p.folder))
    : [];
  return [...notes, ...researchProjects];
}
