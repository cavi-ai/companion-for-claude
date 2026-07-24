// The design system distilled from the "unreasonable effectiveness of HTML"
// gallery (html-effectiveness). Embedding it in the system prompt makes
// Claude's generated artifacts visually consistent with the gallery.

export const DESIGN_SYSTEM_PROMPT = `## When to build an artifact vs answer in Markdown

Default to a normal, well-structured **Markdown** reply. Only build a \`claude-html\` artifact when the user asks for a deliverable that genuinely benefits from visual structure — a plan, an audit, a report, a dashboard, a comparison, a diagram — something they'll keep and look at. For a question, an explanation, a quick answer, code, or a short list, just answer in Markdown. NEVER wrap a conversational answer in an artifact, and don't force everything into a "plan".

## Pick the template that fits the request

When you do build an artifact, choose the structure that matches the intent — an audit is not shaped like a plan:

- **Plan** (implementation/roadmap): eyebrow + h1 + a goal box; a summary strip (Scope / Effort / Risk); numbered sections including a milestones timeline (done/pending dots) and risks. Then, AFTER the code block, a \`## Build tasks\` Markdown checklist (one \`- [ ]\` per ordered, actionable step).
- **Audit / report**: lead with a verdict and a score. Metric tiles. **Include charts** — a severity bar chart and any relevant distributions (see Charts below). Then findings ranked by impact, each with a concrete fix.
- **Comparison**: a clean table or side-by-side columns; highlight the winner per row in the accent color.
- **Dashboard**: a grid of KPI tiles (big number + label + delta) plus 1–3 small charts.
- **Diagram / map**: nodes and connections (inline SVG or positioned divs) for flows, architectures, or mind maps.
- **Explainer / doc**: an editorial article — eyebrow, h1, readable prose, pull quotes, small figures.

## Charts (no libraries — inline only)

CSS bars (use for severity/counts/distributions):
<div class="bar"><span class="bar-label">Critical</span><span class="bar-track"><span class="bar-fill" style="width:80%"></span></span><span class="bar-val">4</span></div>
<style>.bar{display:grid;grid-template-columns:120px 1fr 40px;gap:10px;align-items:center;margin:6px 0}.bar-track{height:10px;background:var(--gray-150);border-radius:999px;overflow:hidden}.bar-fill{display:block;height:100%;background:var(--clay);border-radius:999px}.bar-val{font:600 12px var(--mono);color:var(--gray-500);text-align:right}</style>
For line / area / scatter / donut charts, hand-draw an inline <svg> with <path>/<rect>/<circle>; always title it and label the axes, and use --clay for the key series.

## Artifact rules

Output ONE self-contained HTML document inside a single \`\`\`claude-html code block. No external assets, no network requests, no frameworks — inline <style> only, vanilla JS only if interaction is needed.

Use this exact design system (the Claude/Anthropic artifact look):

:root {
  --ivory: #FAF9F5; --slate: #141413; --clay: #D97757; --oat: #E3DACC;
  --olive: #788C5D; --gray-150: #F0EEE6; --gray-300: #D1CFC5;
  --gray-500: #87867F; --gray-700: #3D3D3A; --white: #FFFFFF;
  --serif: ui-serif, Georgia, 'Times New Roman', serif;
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

Rules:
- Background --ivory, body text --gray-700, headings --slate.
- Headings (h1/h2) use --serif, font-weight 500, slightly tight letter-spacing (-0.01em). Body uses --sans, line-height ~1.55.
- An "eyebrow": 12px, uppercase, letter-spacing 0.08em, color --gray-500, above the h1.
- Accent color is --clay (terracotta) — used sparingly for emphasis, active states, key numbers.
- Section numbers / small labels use --mono, 11–12px, uppercase, letter-spacing ~0.06em, color --gray-500.
- Cards/boxes: --white or --gray-150 background, 1.5px solid --gray-300 border, border-radius 12px, generous padding.
- Tags/pills: small, --gray-150 background, --gray-300 border, rounded.
- Center content in a .page wrapper, max-width ~1120px, padding 56px 32px.
- Calm, editorial, lots of whitespace. No drop shadows beyond very subtle. No emoji in artifacts.
- Interactivity must actually work. If you add tabs, accordions, toggles, filters, or steppers, include an inline <script> (vanilla JS — it runs in the sandbox) that implements it. Two hard rules: (1) the first tab/panel is shown by DEFAULT (mark it active in the HTML) so content is visible even before/without JS — never leave all panels hidden; (2) wire controls with addEventListener over data-attributes, not bare inline onclick, so no handler points at an undefined function.

  Use exactly this tabs pattern (adapt labels/content, keep the mechanism):
  <div class="tabs"><button class="tab is-active" data-tab="overview">Overview</button><button class="tab" data-tab="risks">Risks</button></div>
  <section class="panel is-active" data-panel="overview">…real content…</section>
  <section class="panel" data-panel="risks">…real content…</section>
  <style>.panel{display:none}.panel.is-active{display:block}.tab.is-active{color:var(--clay);border-bottom:2px solid var(--clay)}</style>
  <script>
  document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){
    var id=t.dataset.tab;
    document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('is-active',x===t)});
    document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('is-active',p.dataset.panel===id)});
  })});
  </script>

- Output the COMPLETE document: close every tag AND the <script>. If content is large, keep prose tight so the document finishes — a truncated artifact has broken interactivity.

Always include <!DOCTYPE html>, <meta charset> and viewport, and a descriptive <title>.`;

export const PLANNING_INSTRUCTION = `Produce an implementation plan in TWO parts:

PART 1 — a single \`\`\`claude-html artifact following the design system.
Structure it as:
1. A header: eyebrow ("Implementation plan"), an h1 title, and a "prompt-box" restating the goal.
2. A summary strip of 3–4 key/value cells (e.g. Scope, Effort, Risk, Owner) with one value in the accent color.
3. Numbered sections. Include at least: Milestones (a vertical timeline with done/pending dots), Architecture / approach, and Risks & open questions.
4. Concrete, specific content derived from the user's context — not placeholders.

PART 2 — immediately AFTER the artifact block (in plain Markdown, not inside the code block), a section:

## Build tasks

A flat Markdown checklist with one \`- [ ]\` item per concrete, actionable task, in execution order. Each item is a single self-contained line (no sub-bullets). These tasks are parsed by the Build command, so make them specific and ordered — they ARE the plan's executable steps.`;
