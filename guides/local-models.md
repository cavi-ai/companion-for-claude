# Local models & semantic search

Two independent local-first paths:

- **Chat and utility work on a local LLM** via Ollama — optional. A loopback
  server is desktop-only; mobile utility work can use a LAN or remote endpoint.
- **Semantic search on an on-device embedding model** — every platform, on by default, no external runtime.

You don't need the first to get the second.

## Never lose functionality: the Auto backend

*Settings → Companion for Claude → Connection → Chat backend*

| Backend | Behavior |
|---|---|
| **Claude** (default) | Starts on Claude. Still degrades to local if a request fails for an offline/usage reason and a local model is available. |
| **Auto** | Starts on Claude, falls back to local on any offline/usage failure. |
| **Local only** | Runs every request on Ollama — including the agent, when the selected model supports tools (below). Never calls out. |

Fallback triggers on network loss, rate limits and usage caps, rejected
credentials, and server errors (429/401/403/5xx, plus message-level signals like
`fetch failed`, `quota`, `overloaded`, `ECONNREFUSED`, `timeout`).

It does **not** trigger on a genuine 400 bad request — that's your prompt or
parameters, and a different model won't fix it. A request that already ran locally
is never retried locally.

When a fallback happens you get a short reason rather than a silent model swap:
*"Claude is rate-limited or out of usage"*, *"Claude credential rejected"*,
*"No connection to Claude"*, *"Claude service error"*. A live connectivity
indicator shows which backend is active.

<!-- screenshot: ../assets/local-fallback-indicator.png — pending capture -->

## Setting up Ollama

A localhost Ollama server is desktop-only. Mobile utility work can reach an
Ollama server exposed at a valid LAN or remote HTTP(S) endpoint; do not expose
an unauthenticated model server to the public internet.

1. Install [Ollama](https://ollama.com) and start it.
2. Pull a model: `ollama pull llama3.1` (any chat model works).
3. In Obsidian, open *Settings → Companion for Claude → Local models (Ollama & endpoints)*.
4. Check **Ollama host** — default `http://localhost:11434`.
5. Pick a **Local chat model**. The field becomes a dropdown populated from your Ollama server once models are detected, and stays free text until then.
6. Click **Test local connection**.

### Capability badges

Companion reads each detected model's metadata (`/api/show`) and badges it in
settings:

- **tools ✓** — the model can drive **agent mode** locally (llama3.1, qwen3,
  and similar tool-trained families). Without it the agent switches off for
  that model with a notice, and chat continues as plain completions.
- **thinking ✓** — the model reasons before answering; the composer's
  **reasoning indicator** lights up whenever the active backend thinks (this
  flag on a local model, or extended thinking toggled on for Claude).

Utility work (summaries, tagging, enrichment) always runs with thinking
disabled and a structured-JSON request, so a reasoning model can't burn the
reply budget on hidden reasoning — that failure mode used to surface as
"reply was not valid JSON" during inbox ingestion.

## Routing cheap work locally

Companion routes by task role, not just by a global switch:

- **`chat`** — your primary provider, per the Chat backend above.
- **`utility`** — summaries, auto-tagging, and ingestion.

**Utility tasks backend** — Claude, Ollama (local), or your OpenAI-compatible
endpoint — sends utility work somewhere other than chat. That's the setting that
saves the most tokens for the least quality cost: bulk summarizing and tagging
don't need a frontier model, and a small local model is fine at them. It defaults
to Claude.

Structured utility work (source enrichment) requests JSON against a field-derived
schema and turns thinking off, so reasoning models like qwen3 answer with the
fields instead of spending the token budget on hidden reasoning.

Routing checks that an Ollama host is configured, not that it's answering — so if
you enable this and then stop Ollama, utility tasks will fail rather than silently
re-route to Claude. Use **Test local connection** after changing anything. (The
chat-backend fallback described above *does* probe reachability.)

On mobile, Companion evaluates the utility destination before sending note
content. Loopback and wildcard hosts—including `localhost`, `127.0.0.1`,
`*.localhost`, and IPv6 loopback aliases—cannot reach the desktop from a phone.
For those endpoints, Companion asks whether to use Claude for utility work for
the current plugin session. Choosing **Don't send**, changing the endpoint or
credential, closing the plugin, or lacking an Anthropic credential aborts the
operation without a provider call or vault write. A configured LAN or remote
HTTP(S) endpoint is used directly, and the Source Inbox displays the backend
selected at runtime.

## Semantic search

*Settings → Companion for Claude → Semantic search (local embeddings)*

On by default. Builds a local vector index so the vault is searchable by
**meaning**, not just keywords — powering the "Search vault" context chip,
ask-your-vault, `vault_search` for the agent and the MCP bridge, and related-note
suggestions. Private and on-device.

Search is **hybrid**: keyword hits and semantic hits are fused by reciprocal rank
fusion, deduped per note, each note keeping its best snippet. If the index is
empty or the embedder is unavailable, it degrades to keyword search rather than
returning nothing.

### Three embedding engines

**Built-in (recommended, default)** — runs `Snowflake/snowflake-arctic-embed-xs`
(384-dimension vectors) inside Obsidian via transformers.js, on WebGPU where
available and WASM otherwise. Works on **every platform, including mobile**.

It needs one explicit download: ~45 MB of weights from `huggingface.co` plus
~23 MB of ONNX runtime from `cdn.jsdelivr.net`. Nothing downloads until you click
**Download**; afterwards it's cached and runs fully on-device. A **Clear** button
removes the cached model.

**Ollama** — uses your local Ollama server for embeddings instead
(`nomic-embed-text` by default). Desktop only.

**OpenAI-compatible endpoint** — embeds against the endpoint configured under
*Local models*, using its embedding model.

One pinned default on every platform means one index format, so a desktop-built
index syncs to mobile and stays usable there.

### Building the index

Indexing traverses the vault, chunks each note, embeds the chunks, and stores the
vectors locally. Use **Rebuild index** after switching engines or models — vectors
from different models aren't comparable, which is why the built-in model's index
key is namespaced (`builtin:…`) so it can never collide with an Ollama model name.

**PDFs are indexed too** (the **Index PDF text** toggle, on by default): text is
extracted with pdf.js, chunked without ever crossing a page boundary, and every
chunk carries its **page number** — so semantic results and evidence citations
point at the page, not just the file. Encrypted or unreadable PDFs skip quietly
and never abort a build.

Related-note lookups handle a not-yet-indexed note by live-embedding its first
chunk, so a brand-new note isn't invisible while the index catches up.

## What runs where

| Feature | Desktop | Mobile |
|---|---|---|
| Chat, artifacts, agent mode | Yes | Yes |
| Built-in semantic search + index build | Yes | Yes |
| Ollama chat | Yes | No — localhost cannot be reached from mobile |
| Ollama utility work | Yes | Yes — with a reachable LAN/remote HTTP(S) endpoint |
| Ollama embeddings | Yes | No — use the built-in mobile engine |
| MCP bridge | Yes | No — use cloud sessions |
| Session capture from Claude Code transcripts | Yes | No — browsing captured memory works |

On mobile the settings tab collapses the desktop-only items into one
*🖥 Desktop-only features* note.

## Cost note

Running utility work locally and letting Auto fall back are the two levers that
keep a heavy vault cheap. Prompt caching does the rest — see
[auth.md](auth.md#cost-and-caching).
