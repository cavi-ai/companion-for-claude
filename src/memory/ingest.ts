// The one place a digest becomes a note. Enforces the security contract: every
// text field is sanitized before anything is rendered or written. Two sources
// feed the same tail: a Claude Code CLI transcript (adapter A) or an in-app
// Companion conversation (adapter B). source → digest → sanitize → render → write.

import { App, TFile } from "obsidian";
import { digestTranscript, type SessionDigest } from "./transcript";
import { digestConversation, type ConversationMeta } from "./conversationDigest";
import { sanitizeWithReport } from "./sanitize";
import { renderDigestNote, writeDigestNote } from "./note";
import type { ChatMessage } from "../types";

/** Everything the write tail needs (no source-specific reader). */
export interface PersistDeps {
  app: App;
  folder: string;
  baseTags: string[];
}

export interface IngestDeps extends PersistDeps {
  /** Reads the raw .jsonl for a session (injected for testability). */
  read: (path: string) => Promise<string>;
}

export interface IngestTarget {
  id: string;
  path: string;
}

export interface IngestResult {
  file: TFile;
  sessionId: string;
  redactions: number;
}

/**
 * Sanitize every text field, render, and idempotently write the digest note.
 * The dedup key is resolved once and stamped onto the digest so the rendered
 * `claude-session:` frontmatter is the SAME value writeDigestNote matches on
 * (otherwise a digest with no sessionId renders an empty key and re-ingest dupes).
 */
async function persistDigest(deps: PersistDeps, digest: SessionDigest, fallbackId: string): Promise<IngestResult> {
  let redactions = 0;
  const scrub = (t: string): string => {
    const r = sanitizeWithReport(t);
    redactions += r.redactions.reduce((sum, x) => sum + x.count, 0);
    return r.text;
  };

  const sessionId = digest.sessionId ?? fallbackId;
  const safe: SessionDigest = {
    ...digest,
    sessionId,
    prose: digest.prose.map((p) => ({ ...p, text: scrub(p.text) })),
    toolActions: digest.toolActions.map((a) => ({ ...a, target: a.target ? scrub(a.target) : undefined })),
    filesTouched: digest.filesTouched.map(scrub),
  };
  const vaultNoteBasenames = new Set(deps.app.vault.getMarkdownFiles().map((f) => f.basename));
  const content = renderDigestNote(safe, { baseTags: deps.baseTags, vaultNoteBasenames, redactions });

  const date = (safe.startedAt ?? safe.endedAt ?? "").slice(0, 10) || "session";
  const previewLine = (safe.prose.find((p) => p.role === "user")?.text.split("\n")[0] ?? sessionId).slice(0, 50);
  const fileBase = `${date}-${previewLine}`;

  const file = await writeDigestNote(deps.app, deps.folder, sessionId, content, fileBase);
  return { file, sessionId, redactions };
}

/** Adapter A: ingest a Claude Code CLI transcript file. */
export async function ingestSession(deps: IngestDeps, target: IngestTarget): Promise<IngestResult> {
  const jsonl = await deps.read(target.path);
  return persistDigest(deps, digestTranscript(jsonl), target.id);
}

/** Adapter B: ingest the in-app Companion conversation itself. */
export async function ingestConversation(
  deps: PersistDeps,
  messages: ChatMessage[],
  meta: ConversationMeta,
): Promise<IngestResult> {
  return persistDigest(deps, digestConversation(messages, meta), meta.sessionId ?? "conversation");
}
