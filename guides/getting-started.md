# Getting started

Install Companion for Claude, connect a key, and get to a useful first answer.
Ten minutes, no terminal required.

## 1. Install

**From the community store** — *Settings → Community plugins → Browse* → search
**"Companion for Claude"** → *Install* → *Enable*. Or
[open it directly in Obsidian](obsidian://show-plugin?id=claude-companion).

**Pre-release builds (BRAT)** — install the
[BRAT](obsidian://show-plugin?id=obsidian42-brat) plugin, then *Add beta plugin*
and enter `cavi-ai/companion-for-claude`. Releases are published from that mirror
repo; the store listing tracks it.

## 2. Add your key

The simple path is an Anthropic API key:

1. Open the [Anthropic Console → API keys](https://console.anthropic.com/settings/keys) and create a key.
2. In Obsidian, go to *Settings → Companion for Claude → Connection*.
3. Leave **Authentication** on **API key** and paste the key into **Anthropic API key**.
4. Click **Save & test connection**. A green result means you're done.

You pay Anthropic for usage; nothing is billed by this plugin, and there is no
account to create with us.

Already have a Claude subscription, or an `ANTHROPIC_API_KEY` in your shell? Both
work — see [auth.md](auth.md) for the OAuth-token and environment-import modes,
and for pointing Companion at a gateway.

## 3. Your first chat

Open the panel from the sparkles ribbon icon (*Open Companion for Claude*) or the
command palette (*Open chat panel*).

![The Companion chat panel with vault context attached](../obsidian-plugin/assets/chat-panel.png)

Above the composer is a row of **Context** chips. Toggle one on and its content
rides along with your next message:

- **Active note** — the note you're looking at.
- **Selection** — just the text you highlighted.
- **Linked / Backlinks** — notes the active note points at, and notes pointing back.
- **Search** — a keyword (or semantic, if enabled) sweep of the whole vault.

You can also **@-mention** a specific note, folder, PDF, or image in the
composer, or paste a screenshot straight into it.

Paste a **URL** and you'll get a pill offering to attach the page — Companion
fetches it and reduces it to clean readable markdown (the same Defuddle engine
behind Obsidian's Web Clipper). The fetch only happens when you ask for it, and a
failure shows on the pill instead of derailing the chat.

Try: open a note with some substance, toggle **Active note**, and ask
*"What am I actually claiming here, and what's unsupported?"*

Companion trims attached context to a character budget (default 24,000
characters, 6 notes) so a big vault can't blow up a request. Both are adjustable
under *Settings → Companion for Claude → Behavior*.

## 4. Your first artifact

Type `/` in the composer to open the slash palette — 24 built-in commands plus
your workflows, fuzzy-searchable.

<!-- screenshot: ../assets/slash-palette.png — pending capture -->

Pick **`/artifact`** with a note open. Claude replies with a fenced
`claude-html` block, and Companion renders it **inline in the chat, inside a
sandboxed iframe** — a real interactive page, not a picture of one.

![A claude-html artifact rendered inline](../obsidian-plugin/assets/artifact-inline.png)

From there you can open it in your real browser or save it as a portable note.
See [artifacts.md](artifacts.md) for the sandbox rules and the design system.

Other good first commands: `/summarize`, `/ask` (answers across the whole
vault), `/diagram`, `/canvas`, `/research`.

### Your own slash commands

Any Markdown note in your **templates folder** (*Settings → Companion for Claude
→ Storage → Templates folder*, default `Claude/Templates`) becomes a slash
command. Frontmatter carries `name` and `description`, plus optional `model` and
context-toggle defaults; the body is the prompt.

`{selection}` and `{active_note}` are substituted at run time — unknown
placeholders are left alone rather than mangled. A note named `Standup Summary`
becomes `/standup-summary`.

## 5. Agent mode

Agent mode is **on by default**. It's what lets Claude search and read your vault
on its own mid-answer instead of relying only on the chips you pre-attached. Each
step it takes shows up as a tool chip you can expand.

<!-- screenshot: ../assets/agent-tool-chips.png — pending capture -->

Under *Settings → Companion for Claude → Agent (act on your vault)*:

- **Let Claude use vault tools** — the read-only loop (search, read, follow links). On by default. Turn it off for plain chat with only pre-attached context.
- **Allow write tools** — also lets Claude create, edit, and move notes. On by default, and **every single write asks you first**.
- **Max tool iterations per turn** — how many search/read/write rounds Claude may take before it has to answer. Default 10.

Note edits are a separate, safer path: Claude proposes exact replacements, you
review a **per-hunk red/green diff**, and only the hunks you accept are written.
That happens even with write tools off.

The agent isn't Claude-only: on the **Local only** backend it runs against your
Ollama server too, as long as the selected model supports tools (settings badge
each detected model's tools/thinking capabilities). The composer's **reasoning
indicator** lights up whenever the active backend thinks before answering.

Full detail in [agent-mode.md](agent-mode.md).

## Next steps

- [agent-mode.md](agent-mode.md) — the loop, the tools, the guardrails.
- [artifacts.md](artifacts.md) — `claude-html` blocks and the sandbox.
- [research-workbench.md](research-workbench.md) — evidence-backed writing.
- [claude-code-bridge.md](claude-code-bridge.md) — drive this vault from Claude Code.
- [local-models.md](local-models.md) — Ollama fallback and on-device semantic search.
- [auth.md](auth.md) — API key vs subscription token vs environment.
- [faq.md](faq.md) — cost, privacy, mobile, troubleshooting.
