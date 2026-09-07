// One obsidian-agent skill as a Companion chat turn. Pure.

import type { SkillEntry } from "../workflows/skillRegistry.generated";

const INVOCATION = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/;

export const SKILL_PREAMBLE = [
  'You are running the "{name}" skill from obsidian-agent inside Companion for Claude.',
  "The skill text was written for the `obsidian` command line; in this chat use Companion's vault tools instead:",
  "`obsidian … files` / `search` → vault_search or list_titles; `obsidian … read path=` → note_read; `obsidian … create` → note_create;",
  "`obsidian … append` → note_append; `obsidian … tasks` → vault_search for \"- [ ]\"; targeted edits → propose_note_edit or note_patch.",
  "Every write asks the user first, so a \"preview and confirm\" step is the confirmation dialog. Required sub-skills are included below.",
  "If vault tools are unavailable in this chat, work from the attached context and say what you could not do.",
].join(" ");

export function parseSkillInvocation(text: string, skills: SkillEntry[]): { entry: SkillEntry; args: string } | null {
  const m = INVOCATION.exec(text.trim());
  if (!m?.[1]) return null;
  const entry = skills.find((s) => s.id === m[1]);
  if (!entry) return null;
  return { entry, args: (m[2] ?? "").trim() };
}

export function composeSkillPrompt(entry: SkillEntry, args: string): string {
  const task = args
    ? args
    : entry.argHint
      ? `Run this skill now. It accepts: ${entry.argHint} — none were given, so use the default or ask.`
      : "Run this skill now.";
  return [SKILL_PREAMBLE.replace("{name}", entry.name), `# Skill: ${entry.name}`, entry.body, "# Task", task].join("\n\n");
}

export function skillDisplay(entry: SkillEntry, args: string): string {
  return args ? `/${entry.id} ${args}` : `/${entry.id}`;
}
