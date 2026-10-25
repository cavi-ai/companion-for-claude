/** Page descriptions shared by the tab's page list and the page builders. */
export const PAGE_DESC = {
  agent:
    "One agent, three surfaces. In chat: Claude searches, reads, and — with writes on — edits your vault, asking before every write. "
    + "On desktop, Claude Code uses the official Obsidian CLI by default; the optional bridge serves Claude Desktop and advanced live-vault clients. "
    + "On mobile, a Cloud session works your vault's Git repo and writes replies back.",
  mcpBridge: "Optional advanced bridge for Claude Desktop and live-vault API clients. Claude Code uses the official Obsidian CLI by default and does not need this server. Bound to 127.0.0.1 and protected by a token.",
  mcpClient:
    "Let the in-chat agent use tools from external MCP servers — Companion can serve its vault through the optional desktop bridge and consume other servers here. "
    + "Every external tool call asks for your confirmation. HTTP servers work on mobile; stdio commands run on desktop only.",
  cloudDispatch:
    "Dispatch a Claude Code session in the cloud to work your vault's Git repo and report back — so you can cowork with Claude from a phone, where the local bridge can't run. "
    + "In the Claude Code web UI, create a routine pointed at your vault's Git repo, then complete the checklist.",
  cloudReplies:
    "Pull notes a cloud session wrote back into your vault's GitHub repo — over HTTPS, so it works on a phone with no local git. "
    + "Point this at the repo, branch, and folder the session writes replies to.",
  localModels: "Run cheap, bulk work — summarizing, tagging, ingestion — on a local model to save Anthropic tokens. Chat and plans still use Claude unless you route them here.",
  openaiCompat: "Point at LM Studio, mlx-lm, vLLM, Jan, or Ollama's /v1 mode — including Apple-silicon-optimized servers like `mlx_lm.server`. Select it as the chat backend or utility backend above, and as an embedding engine under Semantic search.",
  sourceCapture: "Point the Obsidian Web Clipper (and dropped CSVs) at an inbox folder; Companion types each new file into a schema-validated source note, reading a clip that arrives empty from its source page. Extraction uses your utility model (local if enabled).",
  discovery: "Discover searches OpenAlex for works and citation links, fills DOI metadata from Crossref and preprint metadata from arXiv, and imports Zotero items by key. Requests run only when you press Search, Expand, or Import.",
  publishing:
    "Publish a note or an artifact as a secret GitHub Gist: anyone with the link can read it and nobody else can find it. "
    + "Needs a fine-grained token with account permission Gists: read and write. Requests run only when you publish, unpublish, or test the token.",
  memory: "Capture Claude Code CLI sessions for this vault into sanitized digest notes. Desktop-only; sessions are matched by the directory you ran Claude Code in.",
};
