// Article → argument map: the model reads one article and returns its thesis,
// claims with evidence and objections, and a takeaway as JSON; Companion checks
// which evidence is quoted from the article and renders a fixed template. Pure.

import { replyJson } from "../providers/replyJson";
import { escapeHtml, page } from "./page";

export interface ArgumentClaim {
  claim: string;
  evidence: string[];
  objections: string[];
}

export interface ArgumentMap {
  thesis: string;
  claims: ArgumentClaim[];
  takeaway: string;
}

export interface ArticleInput {
  title: string;
  summary?: string;
  keyClaims?: string[];
  url?: string;
  /** The note body without frontmatter. */
  text: string;
}

const MAX_TEXT = 16000;
const MAX_CLAIMS = 8;
const MAX_ITEMS = 4;

export const ARGUMENT_MAP_SYSTEM = [
  "Map the argument of one article for a reader.",
  "Use only the article text you are given; never add outside facts.",
  "thesis: the article's central position in one sentence.",
  `claims: 1 to ${MAX_CLAIMS} main claims in the order the article makes them. For each, evidence: up to ${MAX_ITEMS} sentences copied word for word from the article that support it; objections: up to ${MAX_ITEMS} limits or counterpoints the article itself raises (empty when it raises none).`,
  "takeaway: what the reader should remember, in one sentence.",
  "Reply with JSON only.",
].join("\n");

export const ARGUMENT_MAP_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["thesis", "claims", "takeaway"],
  properties: {
    thesis: { type: "string" },
    claims: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CLAIMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence", "objections"],
        properties: {
          claim: { type: "string" },
          evidence: { type: "array", maxItems: MAX_ITEMS, items: { type: "string" } },
          objections: { type: "array", maxItems: MAX_ITEMS, items: { type: "string" } },
        },
      },
    },
    takeaway: { type: "string" },
  },
};

/** The user message: the article's metadata and its text, clipped. */
export function argumentMapPrompt(input: ArticleInput): string {
  const text = input.text.length > MAX_TEXT ? `${input.text.slice(0, MAX_TEXT)}\n[article continues]` : input.text;
  return [
    `Title: ${input.title}`,
    input.summary ? `Summary: ${input.summary}` : "",
    input.keyClaims?.length ? `Key claims noted at capture:\n${input.keyClaims.map((c) => `- ${c}`).join("\n")}` : "",
    "<article>",
    text,
    "</article>",
  ].filter(Boolean).join("\n");
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean).slice(0, MAX_ITEMS) : [];

/** Parse and validate the model's reply; throws with the reason so the repair turn can fix it. */
export function parseArgumentMap(raw: string): ArgumentMap {
  const value = replyJson(raw, (v) => typeof v === "object" && v !== null && !Array.isArray(v)) as Record<string, unknown> | undefined;
  if (!value) throw new Error("The reply is not a JSON object");
  const thesis = typeof value.thesis === "string" ? value.thesis.trim() : "";
  if (!thesis) throw new Error("thesis is missing");
  const claims = (Array.isArray(value.claims) ? value.claims : [])
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({ claim: typeof c.claim === "string" ? c.claim.trim() : "", evidence: strings(c.evidence), objections: strings(c.objections) }))
    .filter((c) => c.claim)
    .slice(0, MAX_CLAIMS);
  if (claims.length === 0) throw new Error("claims must hold at least one claim");
  const takeaway = typeof value.takeaway === "string" ? value.takeaway.trim() : "";
  return { thesis, claims, takeaway };
}

const normalize = (text: string): string => text.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();

/** Whether `evidence` appears word for word (ignoring case, whitespace and markdown marks) in the article. */
export function isQuoted(evidence: string, articleText: string): boolean {
  const needle = normalize(evidence).replace(/^["']|["']$/g, "").replace(/[.…]+$/, "");
  return needle.length >= 12 && normalize(articleText).includes(needle);
}

const CSS = `
.lv-thesis { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 12px 14px; font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.lv-tools { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.lv-claim { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; }
.lv-claim > summary { list-style: none; cursor: pointer; padding: 10px 14px; display: flex; gap: 10px; align-items: baseline; }
.lv-claim > summary::-webkit-details-marker { display: none; }
.lv-num { color: var(--accent); font-weight: 700; min-width: 1.5em; }
.lv-body { padding: 0 14px 12px 40px; }
.lv-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 8px 0 4px; }
.lv-evidence, .lv-objection { margin: 4px 0; padding-left: 10px; border-left: 2px solid var(--line); overflow-wrap: anywhere; }
.lv-evidence.is-quoted { border-left-color: var(--ok); }
.lv-tag { font-size: 11px; color: var(--muted); margin-left: 6px; white-space: nowrap; }
.lv-evidence.is-quoted .lv-tag { color: var(--ok); }
.lv-takeaway { margin-top: 14px; color: var(--muted); }
`;

const SCRIPT = `
var open = false;
document.getElementById("lv-toggle").addEventListener("click", function () {
  open = !open;
  document.querySelectorAll("details.lv-claim").forEach(function (d) { d.open = open; });
  this.textContent = open ? "Collapse all" : "Expand all";
});
`;

/** The argument map as a self-contained page; evidence found in the article is marked quoted. */
export function renderArgumentMap(map: ArgumentMap, input: Pick<ArticleInput, "title" | "url" | "text">): string {
  const claims = map.claims.map((c, i) => {
    const evidence = c.evidence.map((e) => {
      const quoted = isQuoted(e, input.text);
      return `<div class="lv-evidence${quoted ? " is-quoted" : ""}">${escapeHtml(e)}<span class="lv-tag">${quoted ? "Quoted" : "Not found in the article"}</span></div>`;
    }).join("");
    const objections = c.objections.map((o) => `<div class="lv-objection">${escapeHtml(o)}</div>`).join("");
    return [
      `<details class="lv-claim"${i === 0 ? " open" : ""}><summary><span class="lv-num">${i + 1}</span><span>${escapeHtml(c.claim)}</span></summary><div class="lv-body">`,
      evidence ? `<div class="lv-label">Evidence</div>${evidence}` : "",
      objections ? `<div class="lv-label">Objections</div>${objections}` : "",
      "</div></details>",
    ].join("");
  }).join("\n");
  const body = [
    `<div class="lv-thesis">${escapeHtml(map.thesis)}</div>`,
    `<div class="lv-tools"><button id="lv-toggle" type="button">Expand all</button></div>`,
    claims,
    map.takeaway ? `<div class="lv-takeaway">${escapeHtml(map.takeaway)}</div>` : "",
  ].join("\n");
  return page(`${input.title}: argument map`, input.url ?? "", CSS, body, SCRIPT);
}
