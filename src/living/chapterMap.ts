// Video → chapter map: the model reads a transcript and returns a summary,
// chapters and key moments as JSON; Companion snaps every time to a real
// transcript line, renders a fixed template with the searchable transcript, and
// lists timestamp links that open the video. Pure.

import { replyJson } from "../providers/replyJson";
import { embedJson, escapeHtml, page } from "./page";
import { formatTime, parseTime, transcriptLines, youtubeLink, type Transcript } from "./transcript";

export interface Chapter {
  start: number;
  title: string;
  summary: string;
}

export interface KeyMoment {
  time: number;
  moment: string;
}

export interface ChapterMap {
  summary: string;
  chapters: Chapter[];
  moments: KeyMoment[];
}

export interface VideoInput {
  title: string;
  channel?: string;
  summary?: string;
  url?: string;
  transcript: Transcript;
}

const MAX_TRANSCRIPT = 24000;
const MAX_CHAPTERS = 20;
const MAX_MOMENTS = 10;
/** Embedded transcript characters in one view. */
const MAX_EMBED = 200_000;

export const CHAPTER_MAP_SYSTEM = [
  "Map the chapters of one video from its transcript.",
  "Use only the transcript you are given; never add outside facts.",
  "summary: what the video covers, in at most two sentences.",
  `chapters: 1 to ${MAX_CHAPTERS} chapters in order; start is the m:ss time of the transcript line where the chapter begins; title is a few words; summary is one sentence. When the transcript declares chapters, keep their boundaries.`,
  `key_moments: up to ${MAX_MOMENTS} moments worth jumping to, each with the m:ss time of its transcript line and one short sentence.`,
  "Reply with JSON only.",
].join("\n");

export const CHAPTER_MAP_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "chapters", "key_moments"],
  properties: {
    summary: { type: "string" },
    chapters: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CHAPTERS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "title", "summary"],
        properties: { start: { type: "string" }, title: { type: "string" }, summary: { type: "string" } },
      },
    },
    key_moments: {
      type: "array",
      maxItems: MAX_MOMENTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "moment"],
        properties: { time: { type: "string" }, moment: { type: "string" } },
      },
    },
  },
};

/** The user message: the video's metadata and its transcript lines, clipped. */
export function chapterMapPrompt(input: VideoInput): string {
  const declared = input.transcript.chapters.map((c) => `${formatTime(c.start)} ${c.title}`);
  return [
    `Title: ${input.title}`,
    input.channel ? `Channel: ${input.channel}` : "",
    input.summary ? `Summary: ${input.summary}` : "",
    declared.length ? `Chapters the video declares:\n${declared.join("\n")}` : "",
    "<transcript>",
    transcriptLines(input.transcript, MAX_TRANSCRIPT),
    "</transcript>",
  ].filter(Boolean).join("\n");
}

/** The transcript line start nearest `seconds`, or null past the end of the video. */
function snap(seconds: number, transcript: Transcript): number | null {
  const starts = transcript.segments.map((s) => s.start);
  const last = starts[starts.length - 1] ?? 0;
  if (seconds > last + 60) return null;
  return starts.reduce((best, start) => (Math.abs(start - seconds) < Math.abs(best - seconds) ? start : best), starts[0] ?? 0);
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const time = (value: unknown): number | null => (typeof value === "number" && value >= 0 ? value : parseTime(text(value)));

/** Parse and validate the reply, snapping times to transcript lines; throws with the reason for the repair turn. */
export function parseChapterMap(raw: string, transcript: Transcript): ChapterMap {
  const value = replyJson(raw, (v) => typeof v === "object" && v !== null && !Array.isArray(v)) as Record<string, unknown> | undefined;
  if (!value) throw new Error("The reply is not a JSON object");
  const records = (list: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(list) ? list : []).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  const seen = new Set<number>();
  const chapters: Chapter[] = [];
  for (const c of records(value.chapters)) {
    const at = time(c.start);
    const start = at === null ? null : snap(at, transcript);
    const title = text(c.title);
    if (start === null || !title || seen.has(start)) continue;
    seen.add(start);
    chapters.push({ start, title, summary: text(c.summary) });
  }
  if (chapters.length === 0) throw new Error("chapters must hold at least one chapter with an m:ss start inside the transcript");
  chapters.sort((a, b) => a.start - b.start);
  const moments: KeyMoment[] = [];
  for (const m of records(value.key_moments)) {
    const at = time(m.time);
    const snapped = at === null ? null : snap(at, transcript);
    const moment = text(m.moment);
    if (snapped !== null && moment) moments.push({ time: snapped, moment });
  }
  moments.sort((a, b) => a.time - b.time);
  return { summary: text(value.summary), chapters: chapters.slice(0, MAX_CHAPTERS), moments: moments.slice(0, MAX_MOMENTS) };
}

const CSS = `
.lv-summary { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
.lv-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
@media (min-width: 640px) { .lv-grid { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
.lv-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; }
.lv-chapter { display: grid; grid-template-columns: 4.5em minmax(0, 1fr); gap: 2px 8px; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 6px; }
.lv-chapter.is-active { border-color: var(--accent); }
.lv-time { color: var(--accent); font-variant-numeric: tabular-nums; font-weight: 600; }
.lv-title { font-weight: 600; overflow-wrap: anywhere; }
.lv-desc { grid-column: 2; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.lv-moment { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.lv-transcript { margin-top: 12px; }
.lv-transcript input { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; width: 100%; margin-bottom: 6px; }
.lv-lines { max-height: 280px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 4px 10px; font-size: 13px; }
.lv-line { display: flex; gap: 8px; padding: 2px 0; }
.lv-line.is-hit { background: color-mix(in srgb, var(--accent) 14%, transparent); }
`;

const SCRIPT = `
var data = JSON.parse(document.getElementById("lv-data").textContent);
var lines = document.getElementById("lv-lines"), filter = document.getElementById("lv-filter");
function fmt(s) { var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60); return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }
data.segments.forEach(function (s) {
  var row = document.createElement("div"); row.className = "lv-line"; row.dataset.start = String(s.start);
  var t = document.createElement("span"); t.className = "lv-time"; t.textContent = fmt(s.start);
  var x = document.createElement("span"); x.textContent = s.text;
  row.appendChild(t); row.appendChild(x); lines.appendChild(row);
});
filter.addEventListener("input", function () {
  var q = this.value.toLowerCase();
  lines.querySelectorAll(".lv-line").forEach(function (row) { row.style.display = !q || row.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none"; });
});
document.querySelectorAll("[data-jump]").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll(".lv-chapter.is-active").forEach(function (c) { c.classList.remove("is-active"); });
    if (b.classList.contains("lv-chapter")) b.classList.add("is-active");
    filter.value = ""; filter.dispatchEvent(new Event("input"));
    lines.querySelectorAll(".lv-line.is-hit").forEach(function (r) { r.classList.remove("is-hit"); });
    var row = lines.querySelector('.lv-line[data-start="' + b.getAttribute("data-jump") + '"]');
    if (row) { row.classList.add("is-hit"); lines.scrollTop = row.offsetTop - lines.offsetTop; }
  });
});
`;

/** The chapter map as a self-contained page with the transcript embedded. */
export function renderChapterMap(map: ChapterMap, input: Pick<VideoInput, "title" | "channel" | "url" | "transcript">): string {
  const segments: Array<{ start: number; text: string }> = [];
  let size = 0;
  for (const s of input.transcript.segments) {
    if (size + s.text.length > MAX_EMBED) break;
    segments.push({ start: s.start, text: s.text });
    size += s.text.length;
  }
  const chapters = map.chapters.map((c) =>
    `<button type="button" class="lv-chapter" data-jump="${c.start}"><span class="lv-time">${formatTime(c.start)}</span><span class="lv-title">${escapeHtml(c.title)}</span>${c.summary ? `<span class="lv-desc">${escapeHtml(c.summary)}</span>` : ""}</button>`,
  ).join("\n");
  const moments = map.moments.map((m) =>
    `<div class="lv-moment" role="button" tabindex="0" data-jump="${m.time}"><span class="lv-time">${formatTime(m.time)}</span><span>${escapeHtml(m.moment)}</span></div>`,
  ).join("\n");
  const body = [
    `<script type="application/json" id="lv-data">${embedJson({ segments })}</script>`,
    map.summary ? `<div class="lv-summary">${escapeHtml(map.summary)}</div>` : "",
    `<div class="lv-grid"><div><div class="lv-label">Chapters</div>${chapters}</div>`,
    `<div>${moments ? `<div class="lv-label">Key moments</div>${moments}` : ""}</div></div>`,
    `<div class="lv-transcript"><div class="lv-label">Transcript</div><input id="lv-filter" type="search" placeholder="Search the transcript" aria-label="Search the transcript"><div class="lv-lines" id="lv-lines"></div></div>`,
  ].join("\n");
  const meta = [input.channel, input.url].filter(Boolean).join(" · ");
  return page(`${input.title}: chapter map`, meta, CSS, body, SCRIPT);
}

/** Markdown links that open the video at each chapter; empty without a YouTube id. */
export function watchLinks(map: ChapterMap, videoId: string | null): string {
  if (!videoId) return "";
  return ["## Watch", "", ...map.chapters.map((c) => `- [${formatTime(c.start)} ${c.title.replace(/[[\]]/g, "")}](${youtubeLink(videoId, c.start)})`), ""].join("\n");
}

/** The video schema's derived fields, filled from the map. */
export function videoFields(map: ChapterMap): { chapters: number; key_moments: string[]; transcript_summary: string } {
  return {
    chapters: map.chapters.length,
    key_moments: map.moments.map((m) => `${formatTime(m.time)} — ${m.moment}`),
    transcript_summary: map.summary,
  };
}
