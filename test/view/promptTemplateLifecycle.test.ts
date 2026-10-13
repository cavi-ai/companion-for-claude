import { App, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type ClaudeCompanionPlugin from "../../src/main";
import type { PromptTemplate } from "../../src/templates/promptTemplates";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatView } from "../../src/view/ChatView";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

const template = (name: string): PromptTemplate => ({
  name,
  description: name,
  prompt: name,
  path: `Claude/Templates/${name}.md`,
});

describe("Chat template reload lifecycle", () => {
  it("does not let an older vault scan replace a newer slash-command catalog", async () => {
    const older = deferred<PromptTemplate[]>();
    const newer = deferred<PromptTemplate[]>();
    let calls = 0;
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      promptTemplates: () => calls++ === 0 ? older.promise : newer.promise,
    } as unknown as ClaudeCompanionPlugin;
    const view = new ChatView(new WorkspaceLeaf(new App()), plugin);
    const setCommands = vi.fn();
    const seam = view as unknown as {
      slashMenu: { setCommands(commands: unknown[]): void };
      composer: { syncSlashMenu(): void };
      slash: { reload(): Promise<void> };
    };
    seam.slashMenu = { setCommands };
    seam.composer.syncSlashMenu = () => undefined;

    const first = seam.slash.reload();
    const second = seam.slash.reload();
    newer.resolve([template("newer")]);
    await second;
    older.resolve([template("older")]);
    await first;

    expect(setCommands).toHaveBeenCalledOnce();
    const catalog = setCommands.mock.calls[0]![0] as Array<{ name: string; template?: unknown }>;
    expect(catalog.filter((command) => command.template).map(({ name }) => name)).toEqual(["newer"]);
  });
});
