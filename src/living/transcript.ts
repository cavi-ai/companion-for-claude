// Video transcripts for living views: the timestamped lines Defuddle and Web
// Clipper write (`**m:ss** · text`, with `### Chapter` headings), times, and
// YouTube links. Pure.

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  /** Chapters the video itself declares, when the transcript carries them. */
  chapters: Array<{ start: number; title: string }>;
}

/** Seconds for `m:ss`, `mm:ss` or `h:mm:ss`; null for anything else. */
export function parseTime(text: string): number | null {
  const match = /^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const [, h, m, s] = match;
  if (Number(s) > 59 || (h !== undefined && Number(m) > 59)) return null;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const SEGMENT = /^\s*(?:[-*]\s+)?(?:\*\*\[?(\d{1,2}(?::\d{2}){1,2})\]?\*\*|\[(\d{1,2}(?::\d{2}){1,2})\])\s*(?:[·•|–—-]\s*)?(.+?)\s*$/;
/** Defuddle writes a video's own chapters as `###` headings inside the transcript. */
const HEADING = /^\s*###\s+(.+?)\s*$/;

/** Timestamped segments (bold or bracketed times) and `###` chapter headings; null below two segments. */
export function parseTranscript(text: string): Transcript | null {
  const segments: TranscriptSegment[] = [];
  const chapters: Transcript["chapters"] = [];
  let pending: string | null = null;
  for (const line of text.split("\n")) {
    const segment = SEGMENT.exec(line);
    if (segment) {
      const start = parseTime(segment[1] ?? segment[2]!);
      if (start === null) continue;
      if (pending) {
        chapters.push({ start, title: pending });
        pending = null;
      }
      segments.push({ start, text: segment[3]! });
      continue;
    }
    const heading = HEADING.exec(line)?.[1];
    if (heading && !/^transcript$/i.test(heading)) pending = heading;
  }
  return segments.length >= 2 ? { segments, chapters } : null;
}

/** The transcript as prompt lines (`m:ss text`), clipped to `maxChars`. */
export function transcriptLines(transcript: Transcript, maxChars: number): string {
  const lines: string[] = [];
  let size = 0;
  for (const s of transcript.segments) {
    const line = `${formatTime(s.start)} ${s.text}`;
    if (size + line.length + 1 > maxChars) {
      lines.push("[transcript continues]");
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** The YouTube video id in a watch, short, embed or youtu.be URL. */
export function youtubeId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^(www|m)\./, "");
  const id = host === "youtu.be"
    ? parsed.pathname.slice(1)
    : host === "youtube.com"
      ? parsed.pathname === "/watch" ? parsed.searchParams.get("v") ?? "" : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(parsed.pathname)?.[1] ?? ""
      : "";
  return /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** A link that opens the video at `seconds`. */
export function youtubeLink(id: string, seconds: number): string {
  return `https://www.youtube.com/watch?v=${id}&t=${Math.max(0, Math.floor(seconds))}s`;
}
