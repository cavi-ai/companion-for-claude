# FAQ

## Is it free?

The plugin is free and MIT-licensed — the whole feature set, no paid tier, no
account with us.

You pay Anthropic for model usage, either with an API key or by billing to an
existing Claude subscription via a long-term token. Or run
[local models](local-models.md) and pay nothing at all, which also covers
semantic search: the built-in embedding model runs on-device.

See [auth.md](auth.md) for the three credential modes and the caching rates that
keep vault work cheap.

## Does it work on mobile?

Mostly, yes. Chat, agent mode, artifacts, the research workbench, and semantic
search — including building the index — all work on mobile.

Three things need special handling because they rely on a desktop-local runtime:

- **The MCP bridge** — it runs an HTTP server. Use cloud sessions on mobile instead.
- **Ollama** — local chat and embedding models need a localhost server. Utility
  work can use a reachable LAN/remote endpoint; if only a loopback endpoint is
  configured, Companion asks before using Claude for that mobile session.
- **Session capture** — it reads Claude Code transcripts from disk. Browsing already-captured memory works fine on mobile.

On mobile the settings tab collapses those into one *🖥 Desktop-only features*
note, so nothing looks broken.

## Where do my notes go?

To the model provider you configured, and nowhere else. There is **no telemetry,
no analytics, and no phone-home** — the source contains no analytics SDK, no
tracking pixel, and no usage-reporting call.

The complete list of hosts the plugin can ever contact:

| Host | When |
|---|---|
| `api.anthropic.com` (or your gateway) | Chat, utility, and cloud-session requests |
| `localhost:11434` | Your own Ollama server, if enabled |
| The OpenAI-compatible endpoint you configure | Chat, utility, and embedding requests routed to that endpoint |
| `huggingface.co` + `cdn.jsdelivr.net` | One-time embedding-model download, only after you click **Download** |
| `api.openalex.org`, `api.crossref.org`, `export.arxiv.org` | Scholarly Discover searches, only on an explicit action |
| `api.zotero.org` | Resolving a Zotero source on an explicit import, only if you configured a user id |
| `api.github.com` | Cloud replies, only if you configure a vault repo |
| `html.duckduckgo.com` or `api.search.brave.com` | Agent web search, only on an explicit search and only if you enabled the tool |
| The page a web-fetch tool call names | Agent web fetch, only on an explicit tool call and only if you enabled the tool |
| A page you asked to capture or fetch | Web-source capture, attach-page, or the agent's web fetch tool |
| Any MCP server URL you configure | External MCP client tools, on explicit agent tool calls |

On desktop, two optional features touch files outside the vault: session capture
reads Claude Code transcripts from your Claude projects folder, and "open artifact
in browser" writes a temp HTML file. Semantic search reads every note in your vault
to build a local index. All filesystem access is disabled on mobile.

## API key or subscription?

Either. An **API key** is the default and the simplest path — usage bills to your
Anthropic API account. A **long-term OAuth token** from `claude setup-token` bills
to your existing Claude subscription instead.

Both are first-class. What isn't supported is a pasted browser session cookie from
claude.ai — that's outside the plugin's auth surface by design. Details in
[auth.md](auth.md).

## Why is my vault safe from artifact HTML?

Artifacts are model-generated HTML, so they're treated as untrusted. Each one
renders in an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`,
so it has no access to Obsidian's DOM, your vault, or your cookies. On top of that
a CSP with `connect-src 'none'` blocks `fetch`, `XHR`, `sendBeacon`, and
WebSockets outright, `form-action 'none'` blocks submissions, and images/fonts/media
are restricted to `data:`/`blob:`.

Scripts still run, so charts and interactions work — they just have nowhere to send
anything. Full policy in [artifacts.md](artifacts.md#the-sandbox).

## Claude Code can't connect

Work down this list:

1. **Is Obsidian open?** The bridge only runs while the app does.
2. **Is the server enabled?** *Settings → Companion for Claude → Agent bridge — MCP server (desktop)*. The status line reads `✓ Running at http://127.0.0.1:<port>/mcp` when it's up.
3. **Port in use?** The status line says so. Change it and re-copy the snippet.
4. **401?** Token mismatch. Regenerate it, or check whether `OBSIDIAN_COMPANION_MCP_TOKEN` is set and shadowing the stored value.
5. **403?** Something sent a non-loopback `Host` header. Connect to `127.0.0.1` or `localhost` directly.
6. **Write tools missing from the tool list?** *Allow writes* is off — that's the gate working, not a bug.

More in [claude-code-bridge.md](claude-code-bridge.md#troubleshooting).

## Which models can I use?

Claude Opus 5, Claude Opus 4.8, **Claude Sonnet 5** (the default), Claude Haiku
4.5, and Claude Fable 5 from the dropdown, switchable per message from the
composer.

A **Custom model id** field overrides the dropdown for anything newer than this
build knows about, or a gateway-specific name. Connection tests always use Haiku
4.5 so they cost almost nothing.

## Will it change my notes without asking?

No. Three separate gates:

- **Edits** go through a per-hunk red/green diff. Only the hunks you accept are written — and that path stays available even with write tools off, because reviewing the diff *is* the approval.
- **Write tools** (create, append, move, Canvas, Bases, research records) each ask for confirmation before running. Decline and Claude is told, then carries on.
- **Plan Mode** — the **Plan** toggle in the composer hands Claude the read-only tool set only, whatever your settings say. Use it when you want a proposal, not an action.

If Claude is asked to write with writes off, it's instructed to say so plainly
rather than pasting note content into chat as though it had been saved. See
[agent-mode.md](agent-mode.md#the-guardrails).

## Store version or BRAT?

Use the community store — that's the released, reviewed build. Use
[BRAT](obsidian://show-plugin?id=obsidian42-brat) with
`cavi-ai/companion-for-claude` only if you want pre-release builds.

## Something's broken — where do I report it?

Bugs and feature requests: a GitHub issue. Suspected vulnerabilities: **not** a
public issue — follow [`SECURITY.md`](../SECURITY.md).
