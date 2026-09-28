// Handoff packet for a turn stopped by the tool-iteration cap: a compact,
// deterministic record of what the agent already did, stored on the turn
// receipt and injected into the continuation prompt so the next turn resumes
// unfinished work instead of repeating completed writes. Pure — built from the
// tool trace, unit-tested with fixtures.

import type { ToolTraceEntry } from "../types";

export interface HandoffPacket {
  /** Loop cap that was hit; unknown for CLI turns (the CLI enforces it). */
  iterations?: number;
  /** Tool names in first-use order. */
  tools: string[];
  /** Paths/URLs the tools touched, in first-use order. */
  targets: string[];
  /** Names of tools whose last result was an error. */
  failed: string[];
}

const TARGET_KEYS = ["path", "url", "project"] as const;
const MAX_TARGETS = 12;
export const HANDOFF_TEXT_MAX = 1200;

export function buildHandoffPacket(trace: ToolTraceEntry[], iterations?: number): HandoffPacket {
  const tools: string[] = [];
  const targets: string[] = [];
  const failed: string[] = [];
  for (const entry of trace) {
    if (!tools.includes(entry.name)) tools.push(entry.name);
    for (const target of targetsOf(entry.argsSummary)) {
      if (!targets.includes(target) && targets.length < MAX_TARGETS) targets.push(target);
    }
    if (!entry.ok && !failed.includes(entry.name)) failed.push(entry.name);
  }
  return { ...(iterations !== undefined ? { iterations } : {}), tools, targets, failed };
}

/** One "key: value" per line, capped so the receipt stays small. */
export function formatHandoff(packet: HandoffPacket): string {
  const lines = [
    ...(packet.iterations !== undefined ? [`Tool iterations used: ${packet.iterations}`] : []),
    `Tools used: ${packet.tools.length > 0 ? packet.tools.join(", ") : "none"}`,
  ];
  if (packet.targets.length > 0) lines.push(`Files/URLs touched: ${packet.targets.join(", ")}`);
  if (packet.failed.length > 0) lines.push(`Tools that errored: ${packet.failed.join(", ")}`);
  const text = lines.join("\n");
  return text.length > HANDOFF_TEXT_MAX ? `${text.slice(0, HANDOFF_TEXT_MAX)}…` : text;
}

export function handoffResumePrompt(handoff: string): string {
  return [
    "The previous turn hit the tool-iteration limit before the task was finished.",
    "Handoff from that turn:",
    handoff,
    "Inspect the current vault state, report what is already done, and continue only the unfinished work. Do not repeat completed writes.",
  ].join("\n");
}

function targetsOf(argsSummary: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsSummary);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const out: string[] = [];
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) out.push(value.trim());
  }
  return out;
}
