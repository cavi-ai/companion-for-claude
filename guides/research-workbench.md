# Research Desk & Workbench

Writing you can defend. Sources are captured with fingerprints, evidence keeps
the exact excerpt and locator, claims track what supports *and* challenges them,
and drafts are validated so citations can't silently disappear.

Everything is stored as plain Markdown notes in your vault. The vault is the
source of truth — the views are just views.

## Desk vs Workbench

Open the **Research Desk** with `/research`. It's the daily surface: one active
project, its current stage, a deterministic next action with an explanation,
document progress, and a queue of work needing attention. None of that requires a
model request. Pin or dismiss guidance, switch projects, or open the Workbench
when you need record-level control.

<!-- screenshot: ../assets/research-desk.png — pending capture -->

The **Research Workbench** is the advanced surface, grouped into four phases:

| Group | Tabs |
|---|---|
| **Build** | Overview · Sources · Evidence · Claims |
| **Write** | Outline · Draft |
| **Assure** | Audit · Intelligence |
| **Expand** | Discover |

A project moves through seven stages: `frame` → `gather` → `read` → `reason` →
`shape` → `write` → `assure`.

External MCP clients can drive the same canonical records through Companion's
optional [MCP bridge](claude-code-bridge.md). This specialized record API is a
Companion feature; it is not part of the portable `obsidian-agent` CLI package.

## The core path

**Create project → Import source → Capture evidence → Review → Build claims →
Generate outline → Draft → Revise → Assure.**

Getting started is guided rather than blank:

- **Triage clippings** groups a junk-drawer clippings inbox into tagged research themes with a `Triage.md` board — a potential project per theme.
- **New project from active note** seeds a project from the note you have open: question drafted, note imported as the first source, Discover pre-loaded for a preliminary scholarly search.

Along the way, **Sharpen with Claude** rewrites claim propositions grounded in
the evidence you actually checked, and **Draft with Claude** writes evidence
interpretations from the excerpt.

## What gets recorded

- **Sources** receive a content fingerprint at capture. Kinds: web (auto-fetched to clean markdown), PDF, DOI, arXiv, **Zotero** (a `zotero_key` resolves title, authors, publication, DOI, and abstract from your library — set your Zotero user id and, for private libraries, API key under *Scholarly discovery*), and vault notes.
- **Evidence** preserves the exact excerpt, the locator (page, section, paragraph, timestamp, or quote), and the fingerprint captured with it.
- **Claims** keep supporting, challenging, and contextual relations distinct — a claim knows what argues against it.

## Trusted evidence

Only **reviewed**, locatable, non-stale evidence linked to a valid source counts
as trusted claim support. Proposed evidence stays visible but does not satisfy the
audit. Review mutates evidence records only and accepts the terminal states
`reviewed` or `rejected`.

"Stale" is mechanical, not a judgment call: if the source's current fingerprint
differs from the one captured with the evidence, the source changed under you and
the excerpt needs re-verifying.

## Claim-preserving revision

Draft revisions carry the grounded section packet and an explicit intent, the
model's response is validated *before* preview, and you review the proposed
result before it can replace the section.

Unsupported citations, silent claim loss, stale grounding, and malformed revision
responses are **rejected instead of being written into the document**. This is
deterministic validation, not a prompt asking the model to behave.

## The Audit tab

Deterministic checks over the project's records. Nine finding codes, each with a
path and a concrete repair:

| Code | Meaning |
|---|---|
| `broken-reference` | A record points at a missing source, evidence, claim, or question |
| `unsupported-claim` | A claim has no trusted supporting evidence |
| `missing-locator` | Evidence lacks a locator kind or value |
| `unreviewed-evidence` | Evidence is still `proposed` |
| `stale-evidence` | Source fingerprint no longer matches the captured one |
| `unreviewed-claim` | A claim is still `proposed` and can't be used in a trusted outline |
| `rejected-claim` | A rejected claim is referenced by an outline |
| `unused-evidence` | Evidence isn't connected to any claim |
| `invalid-record` | A record failed to parse |

## The Intelligence tab

Deterministic analysis reads the project's canonical records **locally**,
refreshes automatically when those records change, and groups traceable findings
into four categories:

- **Contradictions** identify a claim linked to both trusted supporting and challenging evidence; they do not decide which evidence is stronger.
- **Method differences** identify captured differences such as the source kinds behind supporting and challenging evidence; they do not infer uncaptured methodology.
- **Research gaps** identify open questions, unsupported claims, or places where counterevidence or independent sources should be investigated.
- **Evidence quality** surfaces deterministic audit problems such as stale or unreviewed evidence, missing locators, and broken references.

<!-- screenshot: ../assets/research-workbench-intelligence.png — pending capture -->

### Model narrative (optional)

The separate **Model narrative** runs only when you click **Analyze**. The result
names the provider and model that produced it, and its citations are validated
against paths in the current project before display.

Choose its provider under *Settings → Companion for Claude → Research
intelligence narrator*:

- **Current chat backend** follows the chat setting. Local starts with Ollama; Claude starts with Anthropic; Auto starts with Anthropic and retries with Ollama only when Claude is unavailable, rejects credentials, is rate-limited or out of usage, or returns a server error, and a local model is available.
- **Claude only** uses Anthropic without a local fallback.
- **Local only** uses Ollama.
- **Disabled** removes the Analyze action while deterministic findings remain available.

Narratives are derived summaries, not vault records: they perform no vault writes
and may be marked **Out of date** after the project changes.

Neither the deterministic findings nor the model narrative is a judgment of
scientific validity. Follow each finding's cited paths and verification guidance
before drawing a conclusion.

## The Discover tab

Scholarly search over OpenAlex, enriched with Crossref and arXiv metadata, ranked
locally with an optional model rerank, and importable straight into the project as
sources.

Network requests fire **only on explicit user actions**, and results cache
locally. Enable it under *Settings → Companion for Claude → Scholarly discovery*;
OpenAlex asks for a contact email as a courtesy to their API.

Set a **Zotero user id** (and an API key for a private library) in the same
section and an import with `source_kind: zotero` plus a `zotero_key` resolves the
item's title, authors, date, publication, DOI, url, and abstract from your
library. A failed lookup still imports the key.

## See also

- [agent-mode.md](agent-mode.md) — the two research tools available to Claude in chat, and the seven write-gated ones.
- [claude-code-bridge.md](claude-code-bridge.md) — driving research records from Claude Code.
