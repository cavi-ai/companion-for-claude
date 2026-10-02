import { describe, it, expect, vi } from "vitest";
import { MemoryController, type MemoryControllerDeps } from "../../src/memory/controller";
import { RECORDED_HEADING, splitRecorded } from "../../src/memory/record";
import { DEFAULT_SETTINGS } from "../../src/types";

const MEMORY = "Claude/Sessions/What Claude Knows.md";
const digest = "---\nsession_id: s-1\n---\n\n# Session\n\ndid things\n";
const recordedNote = (...lines: string[]) =>
  `---\ntype: claude-memory\n---\n\n# What Claude Knows\n\n## Projects\n\n- Alpha\n\n${RECORDED_HEADING}\n\n${lines.join("\n")}\n`;

function setup(files: Record<string, string>, reply: () => Promise<string>) {
  const store = new Map(Object.entries(files));
  const prompts: string[] = [];
  const notice = vi.fn();
  const deps = {
    settings: () => ({ ...DEFAULT_SETTINGS, memoryEnabled: true, memoryFolder: "Claude/Sessions" }),
    isMobile: false,
    ingestApp: {},
    vaultBasePath: () => null,
    vault: {
      markdownFilesUnder: (prefix: string) => [...store.keys()].filter((p) => p.startsWith(`${prefix}/`)).map((path) => ({ path, mtime: 1 })),
      readContent: async (path: string) => store.get(path) ?? null,
      writeContent: async (path: string, content: string) => { store.set(path, content); },
    },
    router: () => ({
      complete: async (_role: string, opts: Record<string, unknown>) => {
        prompts.push(String(opts.user));
        return { text: await reply(), provider: { label: "test" } };
      },
    }),
    excludedSessionIds: () => [],
    getActiveConversation: () => null,
    nodeSessionReader: async () => { throw new Error("unused"); },
    notice,
    refreshMemoryView: async () => {},
    openFile: async () => {},
    openSessionPicker: () => {},
    normalizePath: (p: string) => p,
  } as unknown as MemoryControllerDeps;
  return { controller: new MemoryController(deps), store, prompts, notice };
}

const MERGED = "## Projects\n\n- Alpha uses pnpm (recorded 2026-10-02)\n";

describe("consolidateMemory with recorded facts", () => {
  it("runs on recorded facts alone and clears the section on success", async () => {
    const note = recordedNote("- 2026-10-02 · codex · Uses pnpm");
    const { controller, store, prompts } = setup({ [MEMORY]: note }, async () => MERGED);
    await controller.consolidateMemory({ quiet: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("FACTS RECORDED BY AGENTS");
    expect(prompts[0]).toContain("Uses pnpm");
    expect(prompts[0]).not.toContain(RECORDED_HEADING);
    const written = store.get(MEMORY) ?? "";
    expect(written).toContain("Alpha uses pnpm");
    expect(written).not.toContain(RECORDED_HEADING);
  });

  it("leaves the note untouched when the model call fails", async () => {
    const note = recordedNote("- 2026-10-02 · codex · Uses pnpm");
    const { controller, store } = setup({ [MEMORY]: note, "Claude/Sessions/a.md": digest }, async () => { throw new Error("boom"); });
    await controller.consolidateMemory({ quiet: true });
    expect(store.get(MEMORY)).toBe(note);
  });

  it("leaves the note untouched when the reply is unusable", async () => {
    const note = recordedNote("- 2026-10-02 · codex · Uses pnpm");
    const { controller, store } = setup({ [MEMORY]: note }, async () => "");
    await controller.consolidateMemory({ quiet: true });
    expect(store.get(MEMORY)).toBe(note);
  });

  it("keeps a fact recorded while the model was running", async () => {
    const note = recordedNote("- 2026-10-02 · codex · Uses pnpm");
    const late = "- 2026-10-02 · codex · Ships on Fridays";
    const files: Record<string, string> = { [MEMORY]: note };
    const ctx = setup(files, async () => {
      ctx.store.set(MEMORY, `${note}${late}\n`);
      return MERGED;
    });
    await ctx.controller.consolidateMemory({ quiet: true });
    const { recorded } = splitRecorded(ctx.store.get(MEMORY) ?? "");
    expect(recorded).toEqual([late]);
    expect(ctx.store.get(MEMORY)).toContain("Alpha uses pnpm");
  });

  it("does nothing without digests or recorded facts", async () => {
    const { controller, prompts, notice } = setup({ [MEMORY]: "---\ntype: claude-memory\n---\n\n# What Claude Knows\n\n## A\n\n- x\n" }, async () => MERGED);
    await controller.consolidateMemory();
    expect(prompts).toHaveLength(0);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("No session digests"));
  });
});
