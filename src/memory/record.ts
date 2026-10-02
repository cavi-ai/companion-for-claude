// Memory write-back: pure line format, guards, and the "Recorded by agents" section of the memory note.

import { sanitize } from "./sanitize";

export const RECORDED_HEADING = "## Recorded by agents";
export const RECORDED_CAP = 200;
export const FACT_MAX = 500;
const TOPIC_MAX = 40;
const SOURCE_MAX = 32;

export interface RecordInput {
  fact: string;
  topic?: string | undefined;
  source?: string | undefined;
  /** YYYY-MM-DD */
  date: string;
}

export type RecordResult =
  | { kind: "added"; content: string }
  | { kind: "duplicate" }
  | { kind: "error"; message: string };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function normalizeSource(raw: string | undefined): string {
  const s = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, SOURCE_MAX).replace(/-$/, "");
  return s || "agent";
}

function normalizeTopic(raw: string | undefined): string {
  return oneLine(sanitize(raw ?? "").replace(/[[\]]/g, " ")).slice(0, TOPIC_MAX).trim();
}

export function formatRecordLine(input: RecordInput): string | { error: string } {
  const fact = oneLine(sanitize(input.fact));
  if (fact.length === 0) return { error: "fact is empty" };
  if (fact.length > FACT_MAX) return { error: `fact is over ${FACT_MAX} characters` };
  const topic = normalizeTopic(input.topic);
  return `- ${input.date} · ${normalizeSource(input.source)} · ${topic ? `[${topic}] ` : ""}${fact}`;
}

const HEADING_RE = new RegExp(`^${RECORDED_HEADING}[ \\t]*$`, "m");

/** Separate the recorded section from the rest of the note; the section may sit anywhere. */
export function splitRecorded(content: string): { body: string; recorded: string[] } {
  const m = HEADING_RE.exec(content);
  if (!m) return { body: content, recorded: [] };
  const start = m.index;
  const afterHeading = start + m[0].length;
  const next = /^## /m.exec(content.slice(afterHeading));
  const end = next ? afterHeading + next.index : content.length;
  const recorded = content.slice(afterHeading, end).split("\n").filter((l) => l.startsWith("- "));
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end).trimEnd();
  return { body: `${before}${after ? `\n\n${after}` : ""}\n`, recorded };
}

export function renderRecordedSection(lines: string[]): string {
  return `${RECORDED_HEADING}\n\n${lines.join("\n")}`;
}

const factOf = (line: string): string => /^- \d{4}-\d{2}-\d{2} · [a-z0-9-]+ · (?:\[[^\]\n]*\] )?(.*)$/.exec(line)?.[1] ?? line;
const dedupKey = (fact: string): string => oneLine(fact).toLowerCase();

export function appendRecord(content: string | null, input: RecordInput, newNote: (body: string) => string): RecordResult {
  const line = formatRecordLine(input);
  if (typeof line !== "string") return { kind: "error", message: line.error };
  if (content === null) return { kind: "added", content: newNote(renderRecordedSection([line])) };
  const { body, recorded } = splitRecorded(content);
  const key = dedupKey(factOf(line));
  if (recorded.some((l) => dedupKey(factOf(l)) === key)) return { kind: "duplicate" };
  if (recorded.length >= RECORDED_CAP) return { kind: "error", message: `Memory inbox is full (${RECORDED_CAP}). Run Consolidate memory.` };
  return { kind: "added", content: `${body.trimEnd()}\n\n${renderRecordedSection([...recorded, line])}\n` };
}
