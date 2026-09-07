// Word-level diff of one hunk's old/new text. Pure; inputs are hunks, never whole notes.

export type SpanKind = "same" | "del" | "add";

export interface Span {
  kind: SpanKind;
  text: string;
}

// LCS table cap; larger inputs render as one coarse replacement.
const MAX_CELLS = 1_000_000;

/** Words and whitespace runs both survive as tokens so the spans rebuild the input exactly. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

export function wordDiff(a: string, b: string): Span[] {
  if (a === b) return a.length === 0 ? [] : [{ kind: "same", text: a }];
  const x = tokenize(a);
  const y = tokenize(b);
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_CELLS) return coalesce([{ kind: "del", text: a }, { kind: "add", text: b }]);
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = x[i] === y[j] ? dp[(i + 1) * width + j + 1]! + 1 : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const raw: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      raw.push({ kind: "same", text: x[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      raw.push({ kind: "del", text: x[i]! });
      i += 1;
    } else {
      raw.push({ kind: "add", text: y[j]! });
      j += 1;
    }
  }
  while (i < n) raw.push({ kind: "del", text: x[i++]! });
  while (j < m) raw.push({ kind: "add", text: y[j++]! });
  return coalesce(raw);
}

/** Merge adjacent same-kind spans; inside a changed run, deletions precede insertions. */
function coalesce(spans: Span[]): Span[] {
  const out: Span[] = [];
  let del = "";
  let add = "";
  const flush = (): void => {
    if (del) out.push({ kind: "del", text: del });
    if (add) out.push({ kind: "add", text: add });
    del = "";
    add = "";
  };
  for (const s of spans) {
    if (s.text.length === 0) continue;
    if (s.kind === "same") {
      flush();
      const prev = out[out.length - 1];
      if (prev && prev.kind === "same") prev.text += s.text;
      else out.push({ kind: "same", text: s.text });
    } else if (s.kind === "del") {
      del += s.text;
    } else {
      add += s.text;
    }
  }
  flush();
  return out;
}
