# Desktop agents: CLI first, MCP when needed

Companion itself does not require MCP. Its in-app agent already works directly
with the open vault.

On desktop, use the integration that matches the client:

- **Claude Code and other terminal agents:** use the official Obsidian CLI and
  the portable `obsidian-agent` workflows by default.
- **Claude Desktop:** use Companion's read-only loopback MCP bridge because
  Claude Desktop is not a general shell agent.
- **Advanced live-vault API:** MCP remains available when a client needs
  Companion-specific research, semantic-search, ontology, or controlled-write
  tools.

## 1. Set up Claude Code without MCP

Open **Options → Desktop integrations** from any Companion page and choose
**Set up Claude Code**. Companion verifies both CLIs, explains the external
changes, and—only after confirmation—installs or re-enables the user-scoped
plugin with the equivalent of:

```bash
claude plugin marketplace add cavi-ai/plugins
claude plugin install obsidian-agent@cavi-ai --scope user
```

The commands use fixed argument arrays rather than a shell. Companion does not
install Claude Code or Obsidian itself. Once ready, **Open terminal at vault**
opens the external terminal at this vault; run `claude` there and use an
`obsidian-agent` workflow.

Manual prerequisite, in Obsidian 1.12.7 or newer — two steps, both Obsidian's own:

1. *Settings → General → **Command line interface*** turns the CLI on.
2. *Settings → General → **Set up CLI to work in the terminal** → Register* puts
   the command on `PATH`. On macOS this asks for your password and links
   `/usr/local/bin/obsidian`; on Linux it places `~/.local/bin/obsidian`; on
   Windows it adds the Obsidian folder to your user `PATH`.

Companion cannot do either step — placing the command needs elevation Obsidian
asks for itself — so when the CLI is missing, **Desktop integrations** offers
**Open Obsidian CLI settings**, which lands on that page. Companion's own checks
look at all three registration targets and the CLI binary shipped inside
Obsidian, so they do not depend on your shell `PATH`.

The CLI answers only while it can reach the running Obsidian. If Companion
reports it as **installed, not responding**, the command is there but the app is
not reachable — restart Obsidian, or toggle *Command line interface* off and on
to re-register it. That is a different problem from **not found**, which means no
CLI is installed.

## 2. Connect Claude Desktop

Open **Desktop integrations → Connect Claude Desktop**. The confirmation names
the local configuration change and read-only bridge. Companion then:

1. enables its token-required loopback server with writes off;
2. backs up an existing Claude Desktop configuration;
3. atomically merges the `obsidian-vault` server without removing other keys;
4. verifies that the bridge started.

Restart Claude Desktop after the configuration changes. Obsidian must remain
open while Claude Desktop uses the bridge.

Manual recovery (`claude_desktop_config.json`, via `mcp-remote`):

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:22360/mcp", "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

Obsidian has to be open — the bridge only runs while the app does.

## 3. Advanced bridge settings

*Settings → Companion for Claude → Agent bridge — MCP server (desktop)*

<!-- screenshot: ../assets/mcp-bridge-settings.png — pending capture -->

| Setting | Default | Notes |
|---|---|---|
| **Enable MCP server** | Off | Starts the loopback server. Claude Desktop one-click setup enables it explicitly. |
| **Port** | `22360` | Loopback only. Any port 1–65535. |
| **Access token** | generated | Required by clients as a bearer token. Stored as a password field, with a **Regenerate** button. |
| **Allow writes** | Off | Lets connected clients mutate the vault. One-click setup never enables this. |
| **Write folder** | `Claude/Inbox` | Default folder for notes created over MCP. |

A live status line shows `✓ Running at http://127.0.0.1:<port>/mcp`, or tells you
the port is in use.

On Obsidian 1.11.5 and later the bridge token lives in your device's encrypted
secret storage, not in the vault — see [auth.md](auth.md). Setting
`OBSIDIAN_COMPANION_MCP_TOKEN` in your environment keeps it out of plugin data on
any version. Connection snippets are masked by default; copy buttons still copy
the working value.

For an advanced Claude Code MCP connection instead of the default CLI path:

```bash
claude mcp add --transport http obsidian-vault http://127.0.0.1:22360/mcp --header "Authorization: Bearer <token>"
```

## 4. Portable workflow boundary

The Companion MCP bridge is a specialized, optional live-vault integration. It
is not a dependency of portable workflows.

For portable vault workflows, install the separate `obsidian-agent` plugin. It
uses the official Obsidian CLI, does not read Companion's MCP settings, and works
without Companion:

```text
/plugin marketplace add cavi-ai/plugins
/plugin install obsidian-agent@cavi-ai
```

Enable the official CLI in Obsidian 1.12.7 or newer and verify that `obsidian`
is on `PATH`. Try a portable command such as
`/obsidian-agent:vault-synthesis "Summarize the project"`.

## The tool reference

Ten read/audit tools are **always** served. Fourteen mutations appear only when
*Allow writes* is on — so a client can read and audit a research project even
when writing is off.

### Reads (always)

| Tool | Purpose |
|---|---|
| `vault_search` | Search by meaning and keyword; returns matches with a snippet |
| `note_read` | Read a note's full Markdown by vault path |
| `list_recent` | Most recently modified notes |
| `vault_tags` | Existing tags with usage counts, for consistent tagging |
| `list_titles` | Every note as `path — title`, for link/MOC awareness |
| `get_backlinks` | Notes linking to a given note |
| `get_outgoing_links` | Notes a given note links to |
| `frontmatter_query` | Notes matching a frontmatter field, optionally by value |
| `research_project_read` | Compact project snapshot: sources, evidence, claims, issues, health |
| `research_audit` | Audit a research project, returning actionable JSON findings |

### Writes (gated behind *Allow writes*)

| Tool | Purpose |
|---|---|
| `note_create` | Create a note with indexed frontmatter (advertises `type`/`properties` once an ontology is seeded) |
| `note_append` | Append to a note |
| `note_update` | Replace a note's body or a single section |
| `update_frontmatter` | Set tags and frontmatter fields |
| `note_move` | Rename/move a note, rewriting backlinks automatically |
| `base_create` | Emit a `.base` database view over frontmatter |
| `canvas_create` | Emit a `.canvas` mind map with auto-layout, wired to real notes |
| `research_project_create` | Create a research project |
| `research_source_import` | Import a source; web URLs are fetched and reduced to clean readable markdown |
| `research_evidence_capture` | Capture a provenance-linked evidence card |
| `research_evidence_review` | Mark evidence `reviewed` or `rejected` |
| `research_claim_create` | Create a claim with supporting/challenging/contextual relations |
| `research_claim_link` | Link evidence to a claim under a relation |
| `research_outline_generate` | Generate an evidence-backed outline preserving provenance |

In Companion's own agent mode these same writes additionally keep their
per-action confirmation. Permanent legacy aliases stay callable for
compatibility but are intentionally omitted from the advertised catalog. When
the optional **web search** and **web fetch** tools are enabled in settings,
they join the bridge's read set as well.

The client direction works too: the in-chat agent can consume **external MCP
servers** configured under *Settings → External tools — MCP client* — HTTP or
(desktop) stdio, namespaced per server, each call confirmed. See
[agent-mode.md](agent-mode.md#external-mcp-servers).

## What `obsidian-agent` adds separately

The universal package exposes 21 portable capabilities built on a shared
grounding discipline: cite real notes, never fabricate, preview writes, and
verify changes. Claude Code retains thin `/obsidian-agent:` command adapters;
other hosts load the same canonical AgentSkills-compatible workflows.

| Area | Commands / skills |
|---|---|
| **Knowledge** | `vault-synthesis` (grounded, cited "what do I know about X"), `connection-finder`, `source-digest` |
| **Hygiene** | `consistent-tagging`, `wikilink-weaver`, `moc-builder`, `frontmatter-normalizer`, `note-splitter`, `dedup-merge` |
| **Writing** | `outline-to-draft`, `daily-rollup`, `meeting-cleanup`, `summarize-and-link` |
| **Build** | `plan-to-spec`, `tracker-driver`, `build-retrospective`, `task-harvester`, plus the `build-from-spec` command |
| **Advisor personas** | `manifest` with a lens — `pm`, `feature`, `content`, `infra`, `research`, `risk` — plus the separate `manifest-vault` audit: survey the vault and produce grounded, prioritized Markdown or Mermaid output. All share the `manifest-core` spine. |
| **Foundations** | `vault-grounding` and the official Obsidian CLI helper |

Five workflows that require Claude sessions, cloud dispatch, Companion APIs, or
Anthropic artifact conventions remain explicitly Claude-adapter-only and are not
advertised as portable.

Full list and host-specific installation guidance:
[`obsidian-agent`](https://github.com/cavi-ai/obsidian-agent#readme).

## Security model

This is the security-sensitive part of the plugin, and it's deliberately narrow:

- **Loopback only.** The server binds `127.0.0.1`. Your vault is never reachable from the network.
- **A non-empty bearer token is mandatory.** Startup fails outright without one. There is no tokenless mode.
- **Constant-time token comparison**, so a wrong token leaks nothing through timing.
- **Loopback `Host` enforcement.** Requests whose `Host` header isn't a loopback value are rejected with 403 — defense in depth against DNS rebinding, where a page on an attacker domain resolving to `127.0.0.1` would carry that domain as `Host`.
- **Writes off by default**, and separately gated from reads.
- **Only `/mcp` is routed**; any other path 404s. An authorized `GET /mcp` answers a liveness probe, every other method returns 405, and only `POST` carries JSON-RPC.

Reporting policy and boundaries: [`SECURITY.md`](../SECURITY.md).

## Troubleshooting

- **"Not running — check the port isn't in use."** Another process holds the port. Change it and re-copy the snippet.
- **401 from the client.** The token doesn't match. Regenerate, or check whether `OBSIDIAN_COMPANION_MCP_TOKEN` is set and shadowing the stored one.
- **403 from the client.** Something rewrote the `Host` header to a non-loopback value. Connect to `127.0.0.1` or `localhost` directly.
- **Write tools missing from the client's tool list.** *Allow writes* is off — that's the gate working.
- **Nothing responds.** Obsidian is closed, or the vault with Companion enabled isn't open.

## Pairs well with kepano's Obsidian Skills

Steph Ango (@kepano, Obsidian's CEO) publishes
[obsidian-skills](https://github.com/kepano/obsidian-skills) for Obsidian
Flavored Markdown, Bases, JSON Canvas, `obsidian-cli`, and Defuddle web clipping.
His skills teach Claude the *file formats* and work on vault files directly — even
with Obsidian closed. This bridge works the *live, running* vault. They're
complementary; install both.
