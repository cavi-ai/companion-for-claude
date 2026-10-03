// Pure: turns a vault note into the markdown that is safe to publish.

interface Segment {
  text: string;
  code: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FRONTMATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

function isFenceClose(line: string, open: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === open[0] && m[1]!.length >= open.length;
}

/** Splits into code (fences, inline spans) and prose, dropping %% comments from prose. */
function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let prose = "";
  let inComment = false;
  let fence: string | null = null;
  const flush = () => {
    if (prose) out.push({ text: prose, code: false });
    prose = "";
  };

  const lines = text.split("\n");
  lines.forEach((rawLine, index) => {
    const eol = index < lines.length - 1 ? "\n" : "";
    if (fence !== null) {
      out.push({ text: rawLine + eol, code: true });
      if (isFenceClose(rawLine.replace(/\r$/, ""), fence)) fence = null;
      return;
    }
    if (!inComment) {
      const open = FENCE_OPEN.exec(rawLine);
      if (open) {
        flush();
        fence = open[1]!;
        out.push({ text: rawLine + eol, code: true });
        return;
      }
    }
    let i = 0;
    while (i < rawLine.length) {
      if (rawLine.startsWith("%%", i)) {
        inComment = !inComment;
        i += 2;
        continue;
      }
      if (inComment) {
        i += 1;
        continue;
      }
      if (rawLine[i] === "`") {
        let run = 1;
        while (rawLine[i + run] === "`") run += 1;
        const ticks = "`".repeat(run);
        const close = rawLine.indexOf(ticks, i + run);
        if (close !== -1 && rawLine[close + run] !== "`") {
          flush();
          out.push({ text: rawLine.slice(i, close + run), code: true });
          i = close + run;
          continue;
        }
        prose += ticks;
        i += run;
        continue;
      }
      prose += rawLine[i];
      i += 1;
    }
    if (!inComment) prose += eol;
  });
  flush();
  return out;
}

const baseName = (target: string): string => target.split("/").pop() ?? target;
const placeholder = (name: string): string => `*(${name} — not published)*`;
const EXTERNAL = /^(?:https?:|data:|\/\/)/i;

function proseTransform(text: string): string {
  return text
    .replace(/!\[\[([^\]]+)\]\]/g, (_m, inner: string) => placeholder(baseName(inner.split("|")[0]!.trim())))
    .replace(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\s*\)/g, (match, raw: string) => {
      const target = raw.startsWith("<") ? raw.slice(1, -1) : raw;
      if (EXTERNAL.test(target)) return match;
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // keep the raw target
      }
      return placeholder(baseName(decoded));
    })
    .replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const pipe = inner.indexOf("|");
      if (pipe !== -1) return inner.slice(pipe + 1).trim();
      return inner.split("#")[0]!.trim();
    });
}

export function transformNoteForPublish(content: string): string {
  const body = content.replace(FRONTMATTER, "");
  const result = segment(body)
    .map((s) => (s.code ? s.text : proseTransform(s.text)))
    .join("")
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd();
  return result === "" ? "" : `${result}\n`;
}
