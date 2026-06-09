// Pure (Obsidian-free) slash-command registry + filtering. The ChatView owns the
// menu UI and the actual command handlers; this owns the catalog and the
// query→matches logic so it can be unit-tested.

export interface SlashCommand {
  /** The token after "/", e.g. "summarize". Lowercase, no spaces. */
  name: string;
  /** One-line description shown in the palette. */
  description: string;
  /** Aliases that also match this command. */
  aliases?: string[];
  /**
   * What the command does. Either it sends a prompt (insert text + submit) or
   * it runs an action (clear chat, open history, etc.). The ChatView maps the
   * `action` id to a handler.
   */
  kind: "prompt" | "action";
  /** For kind:"prompt" — the prompt template sent to Claude. */
  prompt?: string;
  /**
   * For kind:"prompt" — if true the template is a *prefix* the user finishes
   * typing (e.g. "/ask "), so we insert it and wait rather than auto-send.
   */
  awaitsInput?: boolean;
  /** For kind:"action" — the handler id the ChatView dispatches on. */
  action?: string;
}

export const REGISTERED_ACTION_COMMANDS: Record<string, string> = {
  "new-chat": "new",
  "plan-from-note": "plan",
  "artifact-from-selection": "artifact",
  "ask-vault": "ask",
  "browse-conversations": "history",
  "delete-active-conversation": "delete",
  "build-from-plan": "build",
  "capture-session-memory": "capture",
};

/** A query like "/sum" → the part after the slash, lowercased. */
export function parseSlashQuery(input: string): string | null {
  // Active only when the whole input is a single "/word" with no space yet —
  // i.e. the user is composing a command, not writing prose that contains "/".
  const m = /^\/([a-z0-9-]*)$/i.exec(input);
  return m ? m[1].toLowerCase() : null;
}

/** Filter + rank the catalog for a query (empty query → all, in catalog order). */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  const scored: { cmd: SlashCommand; score: number }[] = [];
  for (const cmd of commands) {
    const names = [cmd.name, ...(cmd.aliases ?? [])];
    let best = -1;
    for (const n of names) {
      if (n === q) best = Math.max(best, 100);
      else if (n.startsWith(q)) best = Math.max(best, 80 - (n.length - q.length));
      else if (n.includes(q)) best = Math.max(best, 40);
    }
    // Also match against description words for discoverability.
    if (best < 0 && cmd.description.toLowerCase().includes(q)) best = 20;
    if (best >= 0) scored.push({ cmd, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}

/** Move a selection index within [0, len) with wrap-around. */
export function moveSelection(current: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return (current + delta + len) % len;
}

/** The built-in slash catalog. Prompt templates mirror the command-palette actions. */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "summarize",
    aliases: ["sum", "tldr"],
    description: "Summarize the active note as concise bullet points, key takeaways first",
    kind: "prompt",
    prompt: "Summarize my active note as concise bullet points, key takeaways first.",
  },
  {
    name: "ask",
    aliases: ["q", "search", "vault", "find"],
    description: "Ask a question answered across your whole vault (turns on vault search)",
    kind: "action",
    action: "ask-vault",
  },
  {
    name: "improve",
    aliases: ["polish", "rewrite"],
    description: "Improve the writing in the active note or selection",
    kind: "prompt",
    prompt: "Improve the clarity, flow, and concision of the selected text (or my active note if nothing is selected). Preserve meaning and voice; return the revised text.",
  },
  {
    name: "artifact",
    aliases: ["dashboard", "viz"],
    description: "Turn the note/selection into a beautiful HTML artifact",
    kind: "action",
    action: "artifact",
  },
  {
    name: "plan",
    description: "Generate an implementation plan from the active note",
    kind: "action",
    action: "plan",
  },
  {
    name: "table",
    description: "Turn the note/selection into a clean Markdown table",
    kind: "prompt",
    prompt: "Turn the key information in my active note (or selection) into a clean, well-structured Markdown table.",
  },
  {
    name: "brainstorm",
    aliases: ["ideas", "ideate"],
    description: "Brainstorm options from the active note or a typed topic",
    kind: "prompt",
    prompt: "Brainstorm strong, concrete ideas for: ",
    awaitsInput: true,
  },
  {
    name: "diagram",
    aliases: ["map", "flow"],
    description: "Create a clear visual diagram artifact",
    kind: "prompt",
    prompt: "Create a single self-contained ```claude-html artifact with a clear visual diagram for: ",
    awaitsInput: true,
  },
  {
    name: "links",
    aliases: ["backlinks", "related"],
    description: "Suggest useful internal links for the active note",
    kind: "prompt",
    prompt: "Suggest useful internal Obsidian links for my active note. Group them by why they are relevant and include concise link text.",
  },
  {
    name: "daily",
    aliases: ["today", "journal"],
    description: "Draft or improve today's daily note",
    kind: "prompt",
    prompt: "Draft today's daily note from my current context. Include priorities, open loops, decisions, and next actions.",
  },
  {
    name: "outline",
    aliases: ["structure"],
    description: "Create a tight outline for the active note",
    kind: "prompt",
    prompt: "Create a clean outline of my active note with headings, key claims, missing sections, and suggested order.",
  },
  {
    name: "compare",
    aliases: ["contrast"],
    description: "Compare the selection or active note against another topic",
    kind: "prompt",
    prompt: "Compare my active note or selection against: ",
    awaitsInput: true,
  },
  {
    name: "extract",
    aliases: ["actions", "todos"],
    description: "Extract decisions, tasks, risks, and follow-ups",
    kind: "prompt",
    prompt: "Extract decisions, tasks, risks, owners, dates, and follow-ups from my active note or selection. Return a compact action list.",
  },
  {
    name: "explain",
    description: "Explain a topic — type your topic after the command",
    kind: "prompt",
    prompt: "Explain in clear, simple terms: ",
    awaitsInput: true,
  },
  {
    name: "build",
    description: "Hand off the current plan note to Claude Code",
    kind: "action",
    action: "build",
  },
  {
    name: "workflows",
    aliases: ["manifest", "manifests", "roadmap", "skills"],
    description: "Run a vault workflow — manifests, daily rollup, MOC, source digest…",
    kind: "action",
    action: "workflows",
  },
  {
    name: "capture",
    aliases: ["memory", "session"],
    description: "Capture a Claude Code session for this vault into memory",
    kind: "action",
    action: "capture-memory",
  },
  {
    name: "new",
    aliases: ["clear", "reset"],
    description: "Start a new conversation",
    kind: "action",
    action: "new-chat",
  },
  {
    name: "history",
    aliases: ["resume"],
    description: "Resume a past conversation",
    kind: "action",
    action: "history",
  },
  {
    name: "save",
    description: "Save this chat to your vault",
    kind: "action",
    action: "save",
  },
  {
    name: "delete",
    aliases: ["delete-chat", "remove"],
    description: "Delete the current conversation",
    kind: "action",
    action: "delete-active",
  },
];
