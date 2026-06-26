export interface CsvMeta {
  columns: string[];
  rows: number;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Parse a CSV's header row + data-row count. Returns null when there is no header. */
export function parseCsvMeta(text: string): CsvMeta | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0];
  if (header === undefined) return null;
  const columns = splitCsvLine(header);
  if (columns.length === 0 || columns.every((c) => c === "")) return null;
  return { columns, rows: Math.max(0, lines.length - 1) };
}
