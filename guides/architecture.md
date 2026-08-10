# Architecture

A map of the Obsidian plugin for anyone reading or contributing to the code.
Everything below lives under `obsidian-plugin/src/`.

`main.ts` is the Obsidian `Plugin` subclass. It registers the chat view, the
`claude-html` Markdown code-block processor, commands, the settings tab, and starts
the MCP bridge on layout-ready. Everything else is organized by concern.

## Module map

| Module | Responsibility |
|---|---|
| `providers/` | `ProviderRouter` builds providers from settings and routes by `TaskRole`: `chat` → Anthropic, `utility` → Ollama when enabled. `anthropic.ts`/`ollama.ts`/`openaiCompat.ts` implement a common `Provider` interface (with a `supportsTools` flag + per-model `capabilities` hook); `ollamaBody.ts`/`ollamaParse.ts` are the pure Ollama wire format (JSON format/schema, thinking off, tool mapping); `jsonRepair.ts` is the shared complete→parse→repair loop; `auth.ts` resolves credential + headers + base URL; `fallback.ts` owns the offline/usage fallback policy; `endpointPolicy.ts` classifies a utility endpoint (loopback, wildcard-local, LAN, remote, invalid) and decides whether mobile may use it, ask to fall back to Claude, or must fail closed; `errorHints.ts` turns raw failures into actionable messages and keeps the underlying cause. |
| `claude/` | `sse.ts` parses the Anthropic streaming response; `models.ts` resolves the model id (dropdown vs custom). |
| `web/` | `search.ts` is the agent's web search (DuckDuckGo HTML and Brave adapters behind one result shape); `fetch.ts` reads one public page as bounded readable markdown. Pure, IO injected. |
| `artifacts/` | `designSystem.ts` holds the design-system prompt injected into every system prompt; `parse.ts` extracts `claude-html` blocks; `renderInline.ts` renders them in a sandboxed iframe with a restrictive CSP; `artifactStore.ts` saves them as notes. |
| `context/` | `vaultContext.ts` assembles per-request context (active note, selection, linked/backlinked notes, vault search, attached pages) within `contextCharBudget`; `search.ts` is keyword scoring; `attachments.ts` handles vault PDFs/images and pasted screenshots as multimodal blocks; `urlContext.ts` detects a pasted URL and shapes the attached-page record, with `webCapture.ts` doing the Defuddle fetch on explicit user action only. |
| `templates/promptTemplates.ts` | User-defined prompt templates: parse a template note's frontmatter (name, description, optional model and context defaults) plus body into a slash command, and substitute `{selection}`/`{active_note}` at run time. Pure — vault IO lives upstream. |
| `semantic/` | The local embeddings index: `indexer.ts` orchestrates traverse → chunk → embed → store (IO injected, markdown and PDF); `pdf.ts` extracts and page-locator-chunks vault PDFs (pdf.js loader injected; `pdfjs.ts` wires the bundled worker); `store.ts` is a pure vector store with (de)serialization; `similarity.ts` is vector math plus reciprocal-rank fusion; `recovery.ts` classifies an embedding failure (missing built-in model, unreachable Ollama or custom endpoint, missing model, mobile loopback endpoint, storage failure) and names the action that fixes it. |
| `mcp/` | `server.ts` is the loopback HTTP MCP server; `vaultTools.ts` implements the read tools always and write tools behind `mcpAllowWrites`; `protocol.ts` is JSON-RPC framing; `clientConfig.ts` emits paste-ready connection snippets. The MCP **client** (external servers in agent mode): `client.ts` is the pure session (handshake/list/call), `external.ts` namespaces tools as `mcp__<server>__<tool>`, `httpTransport.ts`/`stdioTransport.ts` are the transports, `externalManager.ts` owns lazy connect + routing. |
| `agent/` | `loop.ts` runs the stream → execute tools → re-stream turn (pure, deps injected); `tools.ts` adapts MCP tool defs to Anthropic tool-use with write gating and result truncation, and exposes `readOnlyAnthropicTools` for Plan Mode; `prompt.ts` holds the agent system-prompt addendum and the Plan Mode instruction. |
| `edit/diff.ts` | The apply-edits model: validate exact-string replacements, render per-hunk diffs, apply the accepted subset. Pure. |
| `links/` | `unlinkedMentions.ts` finds plain-text occurrences of other notes' titles/aliases; `suggest.ts` merges them with semantic neighbors into one ranked list; `batch.ts` plans link edits across many notes and `inboxBatchReview.ts` turns those plans into one reviewable batch. Pure. |
| `build/` | The spec→build handoff. `spec.ts` extracts tasks from a plan note and renders the build spec plus Claude Code command; `tracker.ts` renders the live progress board as a `claude-html` artifact. |
| `cloud/` | The mobile-friendly cloud loop: `routines.ts` dispatches a Claude Code cloud session; `replies.ts` pulls reply notes from the vault's GitHub repo over the Contents API; `setup.ts` derives the per-step setup state behind the settings checklist. Pure. |
| `workflows/catalog.ts` | Companion-native adaptations of the Claude Code workflows as self-contained prompts. Pure data. |
| `indexing/` | `frontmatter.ts` builds YAML frontmatter on every saved artifact/chat so it indexes in search, the tag pane, and Dataview; `autoTagger.ts` suggests tags reusing existing vault tags. |
| `memory/` | Session memory: `sessions.ts` + `transcript.ts` discover and digest Claude Code CLI sessions (the Node fs reader is desktop-only and lazy-imported); `consolidate.ts` merges digests into the evolving "What Claude Knows" note. |
| `research/` | The Research Workbench: projects, sources, evidence, claims, questions, documents as typed Markdown notes. `repository.ts` is the vault-backed store; `parse.ts`/`render.ts` round-trip records; `identity.ts` dedups sources; `graph.ts` builds snapshots; `audit.ts` flags problems; `draft*`/`revision*` implement claim-grounded drafting and claim-preserving revision; `webCapture.ts` captures web sources as clean markdown; `tools.ts` defines the `research_*` MCP tools. |
| `discovery/` | Scholarly discovery: `adapters/` (OpenAlex, Crossref, arXiv, Zotero item lookup), `coordinator.ts` orchestrates search → merge → rank → optional model rerank → import; `safeUrl.ts` scheme-checks URLs. |
| `sources/` | Typed source capture: `watcher.ts` decides which new inbox files to enrich, `detect.ts` classifies the type, `registry.ts` holds per-type frontmatter schemas, `enrich.ts` fills them (constrained-JSON utility calls, thinking disabled), `frontmatterMerge.ts` unions tags so clips keep their own, `enrichmentQuality.ts` rejects placeholder titles, lost metadata, and malformed provenance inside the atomic write, `clipperSetup.ts` derives the template install state and `clipperVerification.ts` checks clipped notes against the expected type, schema version, and destination, `organize.ts` proposes domain folders and plans collision-safe rename+moves for the clipping organizer. |
| `ontology/` | Vault ontology: `schema.ts` parses schema notes into resolved types with inheritance; `conform.ts` is advisory conformance checking with safe auto-fixes; `digest.ts` injects a compact type digest into the system prompt. |
| `canvas/jsonCanvas.ts` | Validates a model-proposed node/edge graph into JSON Canvas 1.0 with deterministic auto-layout. |
| `bases/baseFile.ts` | Validates a model-proposed database view and emits Obsidian Bases `.base` YAML. |
| `conversations/store.ts` | Pure conversation store — saved chats survive restarts and resume from a session list. |
| `usage/tokens.ts` | Token counting and cost estimation for the context gauge and session totals. |
| `view/` | The side-panel chat UI plus the Research Desk/Workbench views, diff modal, pickers, and slash/at menus. `BatchDiffModal.ts` reviews many notes at once over the pure `batchDiffState.ts` selection model; `inboxRefresh.ts` coalesces Inbox rescans and drops superseded ones; `quickOptions.ts` derives each page's focused option menu (settings last) and `QuickOptionsModal.ts` renders it; `ActivityIndicator.ts` renders the activity drawer over the shared store, ordering needs-attention work first; `companionChrome.ts` mounts both on every Companion view; `ClipperSetupModal.ts` walks through installing the generated clipper templates. |

## The pure-module pattern

Obsidian-free logic — SSE parsing, artifact extraction, search scoring,
frontmatter, MCP protocol framing, provider parsing, the agent loop, diff
application, fallback policy — is factored into **pure modules with no Obsidian
imports**, so it unit-tests without a running app.

Modules that require `obsidian` are tested against an in-memory fake:
`vitest.config.ts` aliases the `obsidian` module to `test/fakes/obsidian.ts`.

The rule for new code: keep the logic in a pure module and test it directly.
Injection is used consistently to make that possible — `loop.ts` takes its stream
and tool executor as deps, `indexer.ts` takes its IO, `consolidate.ts` takes file
contents and the model call.

146 test files and ~1,300 tests run under Vitest, grouped by concern
(`test/research/`, `test/semantic/`, `test/discovery/`, `test/ontology/`,
`test/sources/`, `test/mcp/`). CI runs typecheck, lint, test, and build on Node
20 and 22 for every push and PR.

```bash
pnpm run typecheck   # tsc --noEmit --skipLibCheck
pnpm run lint        # eslint src (tests are typechecked, not linted)
pnpm test            # vitest run
pnpm run build       # typecheck + production bundle
```

## Bundling

`esbuild.config.mjs` bundles `src/main.ts` → `main.js` (CJS, es2021) in **three
passes**:

1. Bundle `src/semantic/transformers/worker.ts` — transformers.js included — to `.build/embed-worker.txt`.
2. Bundle the pdf.js worker (PDF text extraction) to `.build/pdf-worker.txt`.
3. Inline both files as text (`loader: { ".txt": "text" }`) into `main.js`, which instantiates them via Blob-URL workers at runtime.

`obsidian`, `electron`, the CodeMirror packages, and all Node builtins are marked
**external**. The MCP server uses Node `http`, which exists at runtime on desktop
because Obsidian's Electron exposes Node — and is reached through a guarded
dynamic import with inline `import("http")` types, so the bundle never statically
imports a Node builtin and stays loadable on mobile.

Desktop-only features are therefore just the MCP bridge, Ollama, and session
import, gated at runtime. Chat, artifacts, and semantic search all run on mobile.

## Security model

Four boundaries, each documented in [`SECURITY.md`](../SECURITY.md):

**Credentials** live in Obsidian plugin settings on the user's device. Never
logged. Password-typed inputs. The MCP token can be sourced from
`OBSIDIAN_COMPANION_MCP_TOKEN` instead, to keep it out of a synced vault.

**The MCP bridge** must bind `127.0.0.1`, require a non-empty bearer token
(startup fails without one), compare it in constant time, reject non-loopback
`Host` headers, and keep write tools disabled unless explicitly enabled. Don't
widen the bind address, allow a tokenless mode, or expose writes by default.

**Artifacts** are model-generated HTML and must stay sandboxed without
`allow-same-origin`, with network and form submission blocked by CSP. See
[artifacts.md](artifacts.md) for the exact policy.

**Auth surface** is limited to a user-provided API key, a long-term CLI token
from `claude setup-token`, or environment import. Browser/session OAuth from
claude.ai is not supported; a pasted browser session cookie is not an accepted
credential.

## Repo layout

One standalone Obsidian product plus an optional universal-agent reference:

- `obsidian-plugin/` — Companion for Claude, the Obsidian community plugin.
- `claude-plugin/` — compatibility-named pinned submodule of
  [`obsidian-agent`](https://github.com/cavi-ai/obsidian-agent), whose portable
  workflows use the official Obsidian CLI and do not depend on Companion or MCP.
  Companion-native adaptations live in this repository and use Companion's own
  vault context. The optional MCP bridge is a separate Companion integration.
- `upstream/html-effectiveness/`, `upstream/obsidian-skills/` — pinned, unmodified submodules. Provenance in [`NOTICE`](../NOTICE).

Version numbers in `manifest.json`, `versions.json`, and `package.json` must match
the git tag, and `versions.json` maps version → `minAppVersion`. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
