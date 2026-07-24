import { describe, it, expect } from "vitest";
import { dispatchNativeSlashAction, parseSlashQuery, filterCommands, moveSelection, REGISTERED_ACTION_COMMANDS, runNativeSlashCommand, SLASH_COMMANDS, workflowSlashCommands, WORKFLOW_ACTION_PREFIX } from "../src/view/slashCommands";
import { WORKFLOWS } from "../src/workflows/catalog";

describe("native research desk command", () => {
  it("registers /research as a native desk action", () => {
    expect(SLASH_COMMANDS.find(({ name }) => name === "research")).toMatchObject({
      kind: "action",
      action: "open-research-desk",
    });
    expect(filterCommands(SLASH_COMMANDS, "paper").map(({ name }) => name)).toContain("research");
  });

  it("dispatches the desk action without a prompt", async () => {
    const opened: string[] = [];
    const handled = await dispatchNativeSlashAction("open-research-desk", {
      openResearchDesk: async () => { opened.push("opened"); },
    });
    expect(handled).toBe(true);
    expect(opened).toEqual(["opened"]);
  });

  it("does not consume unrelated actions or retain the internal tool prompt", async () => {
    const opened: string[] = [];
    expect(await dispatchNativeSlashAction("history", {
      openResearchDesk: async () => { opened.push("opened"); },
    })).toBe(false);
    expect(opened).toEqual([]);
    expect(JSON.stringify(SLASH_COMMANDS)).not.toContain("research_project_create");
    expect(JSON.stringify(SLASH_COMMANDS)).not.toContain("Use the Research Workbench tools");
  });

  it.each(["claude", "auto", "local"] as const)(
    "opens research without a completion or conversation mutation on the %s backend",
    async (backend) => {
      const conversation = [{ role: "user", content: "Keep this turn" }];
      const before = structuredClone(conversation);
      let composer = "/research";
      let activations = 0;
      let completions = 0;

      const handled = await runNativeSlashCommand({
        command: SLASH_COMMANDS.find(({ name }) => name === "research")!,
        backend,
        clearComposer: () => { composer = ""; },
        activateResearchDesk: async () => { activations += 1; },
        requestCompletion: async () => { completions += 1; },
      });

      expect(handled).toBe(true);
      expect(activations).toBe(1);
      expect(completions).toBe(0);
      expect(composer).toBe("");
      expect(conversation).toEqual(before);
    },
  );
});

describe("workflowSlashCommands", () => {
  it("derives one action command per workflow, dispatched via the workflow: prefix", () => {
    const cmds = workflowSlashCommands(WORKFLOWS);
    expect(cmds).toHaveLength(WORKFLOWS.length);
    for (const c of cmds) {
      expect(c.kind).toBe("action");
      expect(c.action?.startsWith(WORKFLOW_ACTION_PREFIX)).toBe(true);
    }
    // The id round-trips through the action so ChatView can look it up.
    const fm = cmds.find((c) => c.name === "frontmatter-audit");
    expect(fm?.action).toBe(`${WORKFLOW_ACTION_PREFIX}frontmatter-audit`);
  });
  it("merges into the slash catalog so a workflow is reachable by typing '/'", () => {
    const all = [...SLASH_COMMANDS, ...workflowSlashCommands(WORKFLOWS)];
    expect(filterCommands(all, "manifest-pm").some((c) => c.name === "manifest-pm")).toBe(true);
    // Both the per-note command and the vault workflow surface under "front".
    const front = filterCommands(all, "front").map((c) => c.name);
    expect(front).toContain("frontmatter");
    expect(front).toContain("frontmatter-audit");
  });
});

describe("parseSlashQuery", () => {
  it("returns the token after a leading slash", () => {
    expect(parseSlashQuery("/sum")).toBe("sum");
    expect(parseSlashQuery("/")).toBe("");
    expect(parseSlashQuery("/ASK")).toBe("ask"); // lowercased
  });
  it("is null when not a bare command (prose, or a space typed)", () => {
    expect(parseSlashQuery("hello")).toBeNull();
    expect(parseSlashQuery("path/to/thing")).toBeNull();
    expect(parseSlashQuery("/ask question")).toBeNull(); // space → no longer composing a command
    expect(parseSlashQuery("")).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds = SLASH_COMMANDS;
  it("returns everything for an empty query", () => {
    expect(filterCommands(cmds, "")).toHaveLength(cmds.length);
  });
  it("ranks exact + prefix matches first", () => {
    const r = filterCommands(cmds, "sum");
    expect(r[0].name).toBe("summarize"); // matched via prefix/alias
  });
  it("matches aliases", () => {
    expect(filterCommands(cmds, "tldr").map((c) => c.name)).toContain("summarize");
    expect(filterCommands(cmds, "clear").map((c) => c.name)).toContain("new");
  });
  it("falls back to description substring matches", () => {
    const r = filterCommands(cmds, "vault");
    expect(r.map((c) => c.name)).toContain("ask");
  });
  it("returns nothing for gibberish", () => {
    expect(filterCommands(cmds, "zzzxyq")).toHaveLength(0);
  });
});

describe("moveSelection", () => {
  it("wraps around both ends", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(1, 1, 3)).toBe(2);
  });
  it("is safe for an empty list", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe("catalog integrity", () => {
  it("every prompt command has a prompt; every action has an action id", () => {
    for (const c of SLASH_COMMANDS) {
      if (c.kind === "prompt") expect(c.prompt, c.name).toBeTruthy();
      else expect(c.action, c.name).toBeTruthy();
    }
  });
  it("names are unique and slug-shaped", () => {
    const seen = new Set<string>();
    for (const c of SLASH_COMMANDS) {
      expect(/^[a-z0-9-]+$/.test(c.name), c.name).toBe(true);
      expect(seen.has(c.name)).toBe(false);
      seen.add(c.name);
    }
  });
  it("covers the plugin's registered command-palette actions", () => {
    const slashNames = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const slashName of Object.values(REGISTERED_ACTION_COMMANDS)) {
      expect(slashNames.has(slashName), slashName).toBe(true);
    }
  });
  it("includes the newer chat-surface commands", () => {
    const slashNames = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const name of ["brainstorm", "diagram", "links", "dailynote", "outline", "compare", "extract", "capture"]) {
      expect(slashNames.has(name), name).toBe(true);
    }
  });
  it("folds vault-search into /ask (no duplicate /search command)", () => {
    const slashNames = new Set(SLASH_COMMANDS.map((c) => c.name));
    expect(slashNames.has("search")).toBe(false);
    // …but /search, /vault, /find still resolve to ask via aliases.
    expect(filterCommands(SLASH_COMMANDS, "search").map((c) => c.name)).toContain("ask");
    expect(filterCommands(SLASH_COMMANDS, "find").map((c) => c.name)).toContain("ask");
  });
});
