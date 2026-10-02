// A standing order is a prompt-template note whose frontmatter carries a trigger. Pure — vault IO lives upstream.

import type { PromptTemplate } from "../templates/promptTemplates";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type OrderSchedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: Weekday; hour: number; minute: number };

/** folder: normalized, no trailing '/'; tag: lowercase, no '#'. */
export interface NoteTrigger { folder?: string; tag?: string }

export interface StandingOrder {
  id: string;
  name: string;
  path: string;
  prompt: string;
  model?: string;
  enabled: boolean;
  schedule?: OrderSchedule;
  onNote?: NoteTrigger;
}

export type ParsedOrder =
  | { kind: "order"; order: StandingOrder }
  | { kind: "invalid"; path: string; reason: string }
  | { kind: "template" };

const DAILY = /^daily\s+(\d{1,2}):(\d{2})$/i;
const WEEKLY = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;

function validTime(hour: number, minute: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function parseSchedule(raw: unknown): OrderSchedule | { invalid: string } {
  const text = typeof raw === "string" ? raw.trim() : String(raw);
  const invalid = { invalid: `Unrecognised schedule "${text}" — use "daily 08:00" or "weekly mon 08:00".` };
  const daily = DAILY.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    return validTime(hour, minute) ? { kind: "daily", hour, minute } : invalid;
  }
  const weekly = WEEKLY.exec(text);
  if (weekly) {
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    return validTime(hour, minute) ? { kind: "weekly", day: weekly[1]!.toLowerCase() as Weekday, hour, minute } : invalid;
  }
  return invalid;
}

function parseOnNote(raw: unknown): NoteTrigger | { invalid: string } {
  const invalid = { invalid: "on_note needs a folder or a tag." };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid;
  const record = raw as Record<string, unknown>;
  const trigger: NoteTrigger = {};
  if (typeof record.folder === "string") {
    const folder = record.folder.trim().replace(/^\/+|\/+$/g, "");
    if (folder) trigger.folder = folder;
  }
  if (typeof record.tag === "string") {
    const tag = record.tag.trim().replace(/^#+/, "").toLowerCase();
    if (tag) trigger.tag = tag;
  }
  return trigger.folder || trigger.tag ? trigger : invalid;
}

function isInvalid(value: unknown): value is { invalid: string } {
  return typeof value === "object" && value !== null && "invalid" in value;
}

export function parseOrder(template: PromptTemplate, frontmatter: Record<string, unknown>): ParsedOrder {
  const hasSchedule = frontmatter.schedule !== undefined && frontmatter.schedule !== null;
  const hasOnNote = frontmatter.on_note !== undefined && frontmatter.on_note !== null;
  if (!hasSchedule && !hasOnNote) return { kind: "template" };

  const order: StandingOrder = {
    id: template.path,
    name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : (template.path.split("/").pop() ?? template.path).replace(/\.md$/i, ""),
    path: template.path,
    prompt: template.prompt,
    enabled: frontmatter.enabled === true,
  };
  if (template.model) order.model = template.model;
  if (hasSchedule) {
    const schedule = parseSchedule(frontmatter.schedule);
    if (isInvalid(schedule)) return { kind: "invalid", path: template.path, reason: schedule.invalid };
    order.schedule = schedule;
  }
  if (hasOnNote) {
    const onNote = parseOnNote(frontmatter.on_note);
    if (isInvalid(onNote)) return { kind: "invalid", path: template.path, reason: onNote.invalid };
    order.onNote = onNote;
  }
  return { kind: "order", order };
}

export const ORDER_SCAFFOLD = `---
name: My standing order
description: One line on what this order does
schedule: daily 08:00
# on_note:
#   folder: Meetings
#   tag: meeting
enabled: false
---
Write the prompt here. Placeholders substituted on each run:

- {note} — the triggering note's path and content (empty for scheduled runs)
- {date} — the run date, YYYY-MM-DD
`;
