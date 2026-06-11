# Companion for Claude

### Claude, inside your Obsidian vault.

Chat with your notes as context, render **gallery-grade interactive artifacts**
right inside your notes, and capture your Claude Code sessions back into Markdown.
Your vault stays the single source of truth — and nothing leaves your machine
except the call to Anthropic.

[**▶ Install from the Obsidian community store**](obsidian://show-plugin?id=claude-companion)
 · [Latest release](https://github.com/cavi-ai/companion-for-claude/releases/latest)
 · [Claude Code plugin](https://github.com/cavi-ai/claude-obsidian)

![Companion for Claude — chat with your vault, artifacts rendering inline](assets/chat-panel.png)

**Desktop & mobile · MIT · Bring your own Anthropic key · Local-first**

---

## What it does

**🗂 Chat that knows your vault** — streaming, Markdown-rendered replies grounded in
your **active note**, **selection**, **linked & backlinked notes**, or a keyword
**vault search** (lightweight RAG, no embeddings). Copy, insert, save as note, or
regenerate any answer.

**✨ Interactive artifacts, inline** — Claude emits a `claude-html` block and Companion
renders it **live** in a sandboxed iframe — dashboards, diagrams, roadmaps — that you
can open in the browser or **save as a portable note** that stays interactive.

**🔁 Capture your Claude Code work** — pull your **Claude Code** CLI sessions into clean,
**secret-sanitized** digest notes (conversation, tools run, files touched, provenance),
so the work and the knowledge live in the same vault.

<details><summary><b>Everything else</b> — model controls, slash commands, offline fallback, usage display, MCP bridge</summary>

- **In-chat model & reasoning controls** — switch model per message
  (**Opus / Sonnet / Haiku**), toggle **extended thinking** with an **effort** dial,
  stream the reasoning in a collapsible panel, set per-message temperature / max tokens.
  Model-aware: anything a model would reject is hidden, not broken.
- **Slash commands** — type `/` in the composer for a fuzzy palette: `/summarize`,
  `/ask`, `/improve`, `/artifact`, `/plan`, `/table`, `/explain`, `/build`, and more.
- **Conversation history** — chats persist across restarts; resume any past conversation
  from a fuzzy picker.
- **Never lose functionality (offline)** — an **Auto** backend transparently falls back
  to a local **Ollama** model when Claude is offline or out of usage, with a live
  connectivity indicator; or run **Local only** for full offline use.
- **Live usage display** — a context-window gauge plus running session token totals
  (estimated cost on API-key auth, a subscription marker on OAuth) — no billing surprises.
- **Vault as an MCP bridge** — expose your vault to **Claude Code** and **Claude Desktop**
  so all three work against the same notes.
</details>

## See it in action

| A `claude-html` artifact, rendered inline | A ranked manifest roadmap |
|---|---|
| ![The Voxtral one-pager artifact rendered inline in a note](assets/artifact-inline.png) | ![A Vault Optimization roadmap artifact](assets/manifest-roadmap.png) |

The same design system, a different shape — a workflow's working map:

![A Vault Optimization working-map artifact](assets/working-map.png)

## Install

**From the Obsidian community store:** *Settings → Community plugins → Browse →
search "Companion for Claude" → Install → Enable.* Or [open it directly](obsidian://show-plugin?id=claude-companion).

<details><summary>Manual install</summary>

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/cavi-ai/companion-for-claude/releases/latest).
2. Drop them into `<your-vault>/.obsidian/plugins/claude-companion/`.
3. Enable **Companion for Claude** in *Settings → Community plugins*.
</details>

Then open *Settings → Companion for Claude* and add your Anthropic credential (below).

## Authentication — bring your own credential

Companion talks to the Anthropic Messages API with *your* credential — nothing is sent
anywhere else. Three modes:

- **API key** (default, recommended) — a standard `sk-ant-api…` key from
  [console.anthropic.com](https://console.anthropic.com). The community-store path.
- **Long-term OAuth token** (power users) — paste a token from `claude setup-token`
  (`sk-ant-oat…`) to authenticate as your Claude subscription; usage draws on your plan
  rather than pay-as-you-go API credit.
- **Import from environment** — read `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
  (+ `ANTHROPIC_BASE_URL`) from the environment, the way the CLI does.

An optional **base-URL** override points any mode at a gateway/proxy.

## Session memory

Run Claude Code from inside your vault, then in Obsidian:

- **Capture session memory…** (command, ribbon icon, or `/capture`) opens a picker of this
  vault's Claude Code sessions — choose one and it becomes a digest note in your memory
  folder (default `Claude/Sessions`).
- Tick the **ingest** checkbox next to *Save* to also file the **current conversation**
  into memory whenever you save a chat.
- The **Session memory** sidebar lists every capture, with open / re-ingest.

Every text field is run through a **secret scrubber** before anything is written — API
keys, tokens, and credentials in tool output are redacted, not persisted. Captures are
**idempotent**: re-ingesting updates the existing note.

## Slash commands

Type `/` in the composer for a fuzzy palette. Each command works on your active note (or
selection) unless noted; aliases are in parentheses.

**Create from your notes**
- `/summarize` (`/sum`, `/tldr`) — concise bullet summary, key takeaways first
- `/artifact` (`/dashboard`, `/viz`) — turn the note/selection into a beautiful HTML artifact
- `/plan` — generate an implementation plan from the active note
- `/diagram` (`/map`, `/flow`) — a clear visual diagram artifact
- `/table` — a clean Markdown table
- `/outline` (`/structure`) — a tight outline of the note
- `/brainstorm` (`/ideas`) — options from the note or a typed topic
- `/explain` — explain a topic you type after the command

**Work the vault**
- `/ask` (`/search`, `/vault`, `/find`, `/q`) — ask a question answered across your whole vault
- `/links` (`/backlinks`, `/related`) — suggest useful internal links for the note
- `/extract` (`/actions`, `/todos`) — pull out decisions, tasks, risks, and follow-ups
- `/compare` (`/contrast`) — compare the note/selection against another topic
- `/daily` (`/today`, `/journal`) — draft or improve today's daily note
- `/improve` (`/polish`, `/rewrite`) — improve clarity, flow, and concision

**Workflows, memory & handoff**
- `/workflows` (`/manifest`, `/roadmap`) — run a vault workflow (see below)
- `/capture` (`/memory`, `/session`) — capture a Claude Code session for this vault into memory
- `/build` — hand off the current plan note to Claude Code

**Manage the chat**
- `/new` (`/clear`) · `/history` (`/resume`) · `/save` · `/delete`

## Workflows

A **Workflows** picker (the grid icon in the chat header, the `/workflows` command, or the
ribbon) runs grounded, vault-wide playbooks and returns an artifact or linked Markdown:

- **Manifest personas** — *Product roadmap*, *Vault audit*, *Content plan*, *Research agenda*,
  *Risk register*, *Feature backlog*, *Infra design*: each prioritizes and synthesizes across
  your notes into a ranked `claude-html` artifact.
- **Daily rollup** — a skimmable review of recent activity (decisions, changes, open tasks).
- **Map of Content** — a hub note grouping and annotating notes on a topic.
- **Source digest** — a cited evidence/comparison table across your source notes.
- **Harvest tasks** · **Vault synthesis** — consolidate scattered tasks; synthesize what your
  vault says on a topic, cited.

These are the same playbooks the companion `claude-obsidian` Claude Code plugin offers — now
available directly in the chat, no terminal required.

## Interactive artifacts

When Claude returns a fenced ```` ```claude-html ```` block, Companion renders the
document inside a **sandboxed** iframe (`allow-scripts` but **not** `allow-same-origin`)
with a restrictive CSP — interactions and scripts run, but the artifact can't touch your
vault, cookies, network, or forms. Set a height with ` ```claude-html height=720 `.
Saving an artifact writes a Markdown note containing that block, so it lives in your
vault and re-renders in Reading view.

You can author them by hand too:

````markdown
```claude-html height=600
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hello</title></head>
<body style="font-family:ui-serif;background:#FAF9F5;padding:40px">
  <h1 style="color:#141413">It renders inline.</h1>
</body></html>
```
````

## Unified bridge (MCP server)

Companion can expose your vault as a local **MCP server**, so **Claude Code** and
**Claude Desktop** work against the *same* knowledge base you chat with here. Enable it in
*Settings → Companion for Claude → Unified bridge (MCP server)*. It binds to
**127.0.0.1 only**, requires a **bearer token**, exposes read tools always
(`vault_search`, `note_read`, `list_recent`, `vault_tags`) and write tools
(`note_create` / `note_append`) only when *Allow writes* is on, and shows ready-to-paste
connection snippets.

**Claude Code:**

```bash
claude mcp add --transport http obsidian-vault \
  http://127.0.0.1:22360/mcp --header "Authorization: Bearer <token>"
```

## Credits & license

The artifact design system takes its aesthetic cues from Thariq Shihipar's
[“unreasonable effectiveness of HTML”](https://github.com/ThariqS/html-effectiveness)
gallery — an original reformulation, not a copy. See the
[`NOTICE`](https://github.com/cavi-ai/claude-obsidian/blob/main/NOTICE) for full attribution.

Developed in the open at
[`cavi-ai/claude-obsidian`](https://github.com/cavi-ai/claude-obsidian) (this repo is the
published release mirror). MIT — see [`LICENSE`](LICENSE).
