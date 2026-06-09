// Pure rendering of a SessionDigest into a vault note (frontmatter + body), plus
// an idempotent writer (separate, IO section below). The renderer takes only
// data — callers MUST have already sanitized the digest's text fields.

import { App, normalizePath, TFile } from "obsidian";
import { buildFrontmatter, normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import { sanitizeFileName } from "../artifacts/parse";
import type { SessionDigest } from "./transcript";

export interface RenderOptions {
  baseTags: string[];
  /** Basenames (no extension) of vault markdown notes, for wikilinking. */
  vaultNoteBasenames?: Set<string>;
  /** Total redaction count, surfaced in frontmatter. */
  redactions?: number;
  /** Caps to keep huge sessions from producing huge notes. */
  maxProse?: number;
  maxActions?: number;
}

const DEFAULT_MAX_PROSE = 200;
const DEFAULT_MAX_ACTIONS = 200;

function basename(p: string): string {
  const name = p.split("/").pop() ?? p;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function renderFile(path: string, vaultNotes?: Set<string>): string {
  if (path.endsWith(".md") && vaultNotes?.has(basename(path))) return `[[${basename(path)}]]`;
  return `\`${path}\``;
}

export function renderDigestNote(d: SessionDigest, opts: RenderOptions): string {
  const fm: FrontmatterData = {
    session_id: d.sessionId ?? "",
    source: "claude-companion",
    model: d.model,
    git_branch: d.gitBranch,
    started_at: d.startedAt,
    ended_at: d.endedAt,
    user_turns: d.userTurns,
    assistant_turns: d.assistantTurns,
    input_tokens: d.inputTokens,
    output_tokens: d.outputTokens,
    files_touched: d.filesTouched,
    redactions: opts.redactions ?? 0,
    tags: normalizeTags(opts.baseTags),
  };

  const maxProse = opts.maxProse ?? DEFAULT_MAX_PROSE;
  const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS;
  const lines: string[] = [buildFrontmatter(fm), ""];

  const summary = d.prose.find((p) => p.role === "user")?.text.split("\n")[0] ?? "Claude session";
  lines.push(`# ${summary}`, "");

  lines.push("## Conversation", "");
  for (const turn of d.prose.slice(0, maxProse)) {
    lines.push(`**${turn.role === "user" ? "You" : "Claude"}:**`, "", turn.text, "");
  }
  if (d.prose.length > maxProse) lines.push(`_…and ${d.prose.length - maxProse} more turns._`, "");

  if (d.toolActions.length > 0) {
    lines.push("## What Claude did", "");
    for (const a of d.toolActions.slice(0, maxActions)) {
      lines.push(a.target ? `- ${a.tool} — \`${a.target}\`` : `- ${a.tool}`);
    }
    if (d.toolActions.length > maxActions) lines.push(`- _…and ${d.toolActions.length - maxActions} more._`);
    lines.push("");
  }

  if (d.filesTouched.length > 0) {
    lines.push("## Files touched", "");
    for (const f of d.filesTouched) lines.push(`- ${renderFile(f, opts.vaultNoteBasenames)}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const parts = normalizePath(folder).split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        // created concurrently — fine
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Write the digest note for `sessionId`. If a note in `folder` already carries
 * `session_id: <sessionId>` (or the legacy `claude-session:` key from ≤0.6.1),
 * modify it in place; otherwise create a new, uniquely-named note. This is the
 * idempotency guarantee for re-ingest, and it migrates old notes on re-capture.
 */
export async function writeDigestNote(
  app: App,
  folder: string,
  sessionId: string,
  content: string,
  fileBase: string,
): Promise<TFile> {
  await ensureFolder(app, folder);
  const dir = normalizePath(folder);
  const marker = new RegExp(`^(?:session_id|claude-session):\\s*${escapeRe(sessionId)}\\s*$`, "m");

  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(`${dir}/`)) continue;
    const existing = await app.vault.cachedRead(f);
    if (marker.test(existing)) {
      await app.vault.modify(f, content);
      return f;
    }
  }

  const safe = sanitizeFileName(fileBase);
  let path = normalizePath(`${dir}/${safe}.md`);
  let i = 1;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${dir}/${safe} ${i}.md`);
    i++;
  }
  return app.vault.create(path, content);
}
