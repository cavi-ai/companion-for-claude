// Dataset → explorer: the CSV a dataset source points at, as a filterable,
// sortable table with numeric summaries and a bar chart. Deterministic; no
// model call. Pure.

import { embedJson, page } from "./page";

export interface CsvTable {
  columns: string[];
  rows: string[][];
  /** Data rows in the file, including any beyond `rows`. */
  total: number;
}

/** Rows embedded in one view; the rest are counted. */
export const MAX_ROWS = 2000;
/** Characters of cell text embedded in one view. */
const MAX_CHARS = 400_000;

/** Parse CSV text (quoted fields, doubled quotes, newlines inside quotes); null without a header row. */
export function parseCsv(text: string, maxRows = MAX_ROWS): CsvTable | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let chars = 0;
  let total = -1;
  const endRecord = (): void => {
    record.push(field.trim());
    field = "";
    if (record.some((cell) => cell !== "")) {
      total++;
      const size = record.reduce((n, cell) => n + cell.length, 0);
      if (total === 0 || (records.length <= maxRows && chars + size <= MAX_CHARS)) {
        records.push(record);
        chars += size;
      }
    }
    record = [];
  };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) endRecord();
  const [columns, ...rows] = records;
  if (!columns || columns.every((c) => c === "")) return null;
  return { columns, rows: rows.map((r) => columns.map((_, i) => r[i] ?? "")), total: Math.max(0, total) };
}

const CSS = `
.lv-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.lv-bar input, .lv-bar select { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; min-width: 0; }
.lv-bar input { flex: 1 1 160px; }
.lv-count { color: var(--muted); font-size: 12px; }
.lv-wrap { overflow: auto; max-height: 360px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 5px 10px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--card); }
th button { border: none; padding: 0; background: none; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tfoot td { color: var(--muted); font-size: 12px; }
.lv-chart { margin-top: 12px; }
.lv-chart svg { width: 100%; height: auto; display: block; }
.lv-chart rect { fill: var(--accent); }
.lv-chart text { fill: var(--muted); font-size: 10px; }
`;

const SCRIPT = `
var data = JSON.parse(document.getElementById("lv-data").textContent);
var cols = data.columns, rows = data.rows;
function num(v) { if (v === "") return null; var n = Number(String(v).replace(/[,\\s]/g, "")); return isFinite(n) ? n : null; }
var numeric = cols.map(function (_, c) {
  var filled = rows.filter(function (r) { return r[c] !== ""; });
  return filled.length > 0 && filled.filter(function (r) { return num(r[c]) !== null; }).length / filled.length >= 0.8;
});
var sortCol = -1, sortDir = 1, query = "";
var head = document.getElementById("lv-head"), body = document.getElementById("lv-body"), foot = document.getElementById("lv-foot");
var count = document.getElementById("lv-count"), pick = document.getElementById("lv-pick"), chart = document.getElementById("lv-chart");
cols.forEach(function (name, c) {
  var th = document.createElement("th"); if (numeric[c]) th.className = "num";
  var b = document.createElement("button"); b.type = "button"; b.textContent = name;
  b.addEventListener("click", function () { sortDir = sortCol === c ? -sortDir : 1; sortCol = c; draw(); });
  th.appendChild(b); head.appendChild(th);
  if (numeric[c]) { var o = document.createElement("option"); o.value = String(c); o.textContent = name; pick.appendChild(o); }
});
if (!pick.options.length) pick.parentElement.style.display = "none";
document.getElementById("lv-filter").addEventListener("input", function () { query = this.value.toLowerCase(); draw(); });
pick.addEventListener("change", draw);
function visible() {
  var out = rows.filter(function (r) { return !query || r.some(function (v) { return v.toLowerCase().indexOf(query) >= 0; }); });
  if (sortCol >= 0) out = out.slice().sort(function (a, b) {
    var x = a[sortCol], y = b[sortCol];
    if (numeric[sortCol]) { var nx = num(x), ny = num(y); if (nx === null) return 1; if (ny === null) return -1; return (nx - ny) * sortDir; }
    return x.localeCompare(y) * sortDir;
  });
  return out;
}
function draw() {
  var shown = visible();
  body.textContent = "";
  shown.forEach(function (r) {
    var tr = document.createElement("tr");
    r.forEach(function (v, c) { var td = document.createElement("td"); if (numeric[c]) td.className = "num"; td.textContent = v; tr.appendChild(td); });
    body.appendChild(tr);
  });
  count.textContent = shown.length + " of " + data.total + " rows" + (rows.length < data.total ? " (first " + rows.length + " loaded)" : "");
  foot.textContent = "";
  var tr = document.createElement("tr");
  cols.forEach(function (_, c) {
    var td = document.createElement("td");
    if (numeric[c]) {
      var ns = shown.map(function (r) { return num(r[c]); }).filter(function (n) { return n !== null; });
      if (ns.length) { var sum = ns.reduce(function (a, b) { return a + b; }, 0); td.className = "num";
        td.textContent = "min " + Math.min.apply(null, ns) + " · mean " + (Math.round(sum / ns.length * 100) / 100) + " · max " + Math.max.apply(null, ns); }
    }
    tr.appendChild(td);
  });
  foot.appendChild(tr);
  drawChart(shown);
}
function drawChart(shown) {
  chart.textContent = "";
  if (!pick.value) return;
  var c = Number(pick.value), pts = shown.slice(0, 60).map(function (r) { return { label: r[0], v: num(r[c]) }; }).filter(function (p) { return p.v !== null; });
  if (!pts.length) return;
  var max = Math.max.apply(null, pts.map(function (p) { return Math.abs(p.v); })) || 1, w = 600, h = 180, bw = w / pts.length;
  var ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 " + w + " " + (h + 16)); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", cols[c] + " by row");
  pts.forEach(function (p, i) {
    var bh = Math.abs(p.v) / max * h, rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", String(i * bw + 1)); rect.setAttribute("y", String(h - bh)); rect.setAttribute("width", String(Math.max(1, bw - 2))); rect.setAttribute("height", String(bh));
    var t = document.createElementNS(ns, "title"); t.textContent = p.label + ": " + p.v; rect.appendChild(t); svg.appendChild(rect);
    if (pts.length <= 20) { var l = document.createElementNS(ns, "text"); l.setAttribute("x", String(i * bw + bw / 2)); l.setAttribute("y", String(h + 12)); l.setAttribute("text-anchor", "middle"); l.textContent = String(p.label).slice(0, 10); svg.appendChild(l); }
  });
  chart.appendChild(svg);
}
draw();
`;

/** The explorer as a self-contained page with the table data embedded. */
export function renderDatasetExplorer(table: CsvTable, meta: { title: string; asset: string }): string {
  const body = [
    `<script type="application/json" id="lv-data">${embedJson(table)}</script>`,
    `<div class="lv-bar"><input id="lv-filter" type="search" placeholder="Filter rows" aria-label="Filter rows"><label>Chart <select id="lv-pick" aria-label="Chart column"></select></label><span class="lv-count" id="lv-count"></span></div>`,
    `<div class="lv-wrap"><table><thead><tr id="lv-head"></tr></thead><tbody id="lv-body"></tbody><tfoot id="lv-foot"></tfoot></table></div>`,
    `<div class="lv-chart" id="lv-chart"></div>`,
  ].join("\n");
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  return page(`${meta.title}: dataset explorer`, `${meta.asset} · ${plural(table.columns.length, "column")} · ${plural(table.total, "row")}`, CSS, body, SCRIPT);
}
