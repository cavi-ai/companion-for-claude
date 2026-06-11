// Pure generator for a live "build tracker" — a claude-html artifact that shows
// task progress. Claude Code appends checkbox lines to the note; this renders
// the initial board. Obsidian-free for tests.

import type { BuildTask } from "./spec";

export function trackerArtifact(title: string, tasks: BuildTask[]): string {
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const rows = tasks
    .map((t) => {
      const cls = t.done ? "row done" : "row";
      const mark = t.done ? "✓" : "";
      return `      <div class="${cls}"><span class="box">${mark}</span><span class="task">${escapeHtml(t.title)}</span></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Build tracker — ${escapeHtml(title)}</title>
<style>
  :root{--ivory:#FAF9F5;--slate:#141413;--clay:#D97757;--olive:#788C5D;
    --gray-150:#F0EEE6;--gray-300:#D1CFC5;--gray-500:#87867F;--gray-700:#3D3D3A;
    --serif:ui-serif,Georgia,'Times New Roman',serif;--sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    --mono:'SF Mono',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:var(--sans);background:var(--ivory);color:var(--gray-700);padding:32px;line-height:1.5}
  .page{max-width:760px;margin:0 auto}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--gray-500);margin-bottom:8px}
  h1{font-family:var(--serif);font-weight:500;font-size:26px;color:var(--slate);margin-bottom:18px}
  .bar{height:10px;border-radius:6px;background:var(--gray-300);overflow:hidden;margin-bottom:6px}
  .fill{height:100%;width:${pct}%;background:var(--olive)}
  .meta{font-family:var(--mono);font-size:12px;color:var(--gray-500);margin-bottom:22px}
  .row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--gray-300)}
  .row:last-child{border-bottom:none}
  .box{flex:0 0 20px;height:20px;border:1.5px solid var(--gray-300);border-radius:5px;display:grid;place-items:center;
    font-size:12px;color:#fff;background:#fff}
  .row.done .box{background:var(--olive);border-color:var(--olive)}
  .row.done .task{color:var(--gray-500);text-decoration:line-through}
  .task{font-size:14.5px}
</style>
</head>
<body>
  <div class="page">
    <div class="eyebrow">Build tracker</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="bar"><div class="fill"></div></div>
    <div class="meta">${done} / ${tasks.length} tasks · ${pct}%</div>
    <div class="list">
${rows}
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
