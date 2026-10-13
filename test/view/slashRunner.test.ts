import { App, clearNotices, getNoticeMessages, MarkdownView, type EventRef } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptTemplate } from "../../src/templates/promptTemplates";
import { DEFAULT_SETTINGS } from "../../src/types";
import { WORKFLOWS } from "../../src/workflows/catalog";
import { SlashRunner, type SlashRunnerDeps, type SlashRunnerHost } from "../../src/view/chat/slashRunner";
import type { SlashCommand } from "../../src/view/slashCommands";

type Handler = (...args: unknown[]) => void;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

const template = (name: string, extra: Partial<PromptTemplate> = {}): PromptTemplate => ({
  name,
  description: name,
  prompt: name,
  path: `Claude/Templates/${name}.md`,
  ...extra,
});

function rig(options: { templates?: () => Promise<PromptTemplate[]>; activeView?: unknown; actions?: Record<string, () => unknown> } = {}) {
  const handlers = new Map<string, Handler>();
  const refs: EventRef[] = [];
  const app = new App();
  (app.vault as unknown as { on: (name: string, cb: Handler) => EventRef }).on = (name, cb) => {
    handlers.set(name, cb);
    return { name } as unknown as EventRef;
  };
  (app.vault as unknown as { cachedRead: (file: unknown) => Promise<string> }).cachedRead = async () => "NOTE BODY";
  (app.workspace as unknown as { getActiveViewOfType: unknown }).getActiveViewOfType = (type: unknown) => (type === MarkdownView ? options.activeView ?? null : null);
  const runWorkflow = vi.fn(async () => undefined);
  const plugin = {
    settings: { ...structuredClone(DEFAULT_SETTINGS), templatesFolder: "Claude/Templates//" },
    promptTemplates: options.templates ?? (async () => []),
    views: () => ({ runWorkflow }),
    commandActions: () => options.actions ?? {},
  } as unknown as SlashRunnerHost;
  const order: string[] = [];
  const deps = {
    clearInput: vi.fn(() => { order.push("clear"); }),
    setDraft: vi.fn(),
    updateUsageBar: vi.fn(),
    submitPrompt: vi.fn(async () => { order.push("submit"); return true; }),
    setCommands: vi.fn(),
    view: { newChat: vi.fn(), openHistory: vi.fn(), save: vi.fn(async () => undefined), askVault: vi.fn() },
  } satisfies SlashRunnerDeps;
  const runner = new SlashRunner(app, plugin, deps);
  return { runner, deps, plugin, handlers, refs, runWorkflow, order };
}

const command = (extra: Partial<SlashCommand>): SlashCommand => ({ name: "cmd", description: "", kind: "action", ...extra });

beforeEach(() => clearNotices());

describe("SlashRunner.run", () => {
  it("substitutes placeholders from the active markdown view and submits with the template overrides", async () => {
    const view = Object.assign(new MarkdownView(), { editor: { getSelection: () => "SELECTED" }, file: { path: "a.md" } });
    const { runner, deps, order } = rig({ activeView: view });
    const tpl = template("rewrite", { prompt: "Fix {selection} in {active_note}", model: "m-1", context: { activeNote: true } });
    await runner.run(command({ name: "rewrite", kind: "prompt", template: tpl }));
    expect(order).toEqual(["clear", "submit"]);
    expect(deps.submitPrompt).toHaveBeenCalledWith("Fix SELECTED in NOTE BODY", "/rewrite", undefined, { model: "m-1", context: { activeNote: true } });
  });

  it("submits a template with no overrides and no active view with empty placeholders", async () => {
    const { runner, deps } = rig();
    await runner.run(command({ name: "plain", kind: "prompt", template: template("plain", { prompt: "[{selection}][{active_note}]" }) }));
    expect(deps.submitPrompt).toHaveBeenCalledWith("[][]", "/plain", undefined, {});
  });

  it("inserts an awaiting prompt as a draft without submitting, and submits other prompts under the command name", async () => {
    const { runner, deps } = rig();
    await runner.run(command({ name: "explain", kind: "prompt", prompt: "Explain: ", awaitsInput: true }));
    expect(deps.setDraft).toHaveBeenCalledWith("Explain: ");
    expect(deps.updateUsageBar).toHaveBeenCalledOnce();
    expect(deps.submitPrompt).not.toHaveBeenCalled();
    await runner.run(command({ name: "summarize", kind: "prompt", prompt: "Summarize the note." }));
    expect(deps.submitPrompt).toHaveBeenCalledWith("Summarize the note.", "/summarize");
  });

  it("inserts a skill token as the draft", async () => {
    const { runner, deps } = rig();
    await runner.run(command({ name: "review", action: "skill:code-review" }));
    expect(deps.setDraft).toHaveBeenCalledWith("/code-review ");
    expect(deps.updateUsageBar).toHaveBeenCalledOnce();
  });

  it("runs the matching workflow and notices an unknown workflow id", async () => {
    const { runner, runWorkflow } = rig();
    const wf = WORKFLOWS[0]!;
    await runner.run(command({ name: wf.id, action: `workflow:${wf.id}` }));
    expect(runWorkflow).toHaveBeenCalledWith(wf);
    await runner.run(command({ name: "nope", action: "workflow:nope" }));
    expect(runWorkflow).toHaveBeenCalledOnce();
    expect(getNoticeMessages()).toContain("Unknown workflow: nope");
  });

  it("dispatches plugin and view actions and notices an unknown command", async () => {
    const generatePlanFromNote = vi.fn();
    const { runner, deps } = rig({ actions: { generatePlanFromNote } });
    await runner.run(command({ name: "plan", action: "generatePlanFromNote" }));
    expect(generatePlanFromNote).toHaveBeenCalledOnce();
    await runner.run(command({ name: "history", action: "history" }));
    expect(deps.view.openHistory).toHaveBeenCalledOnce();
    await runner.run(command({ name: "save", action: "save" }));
    expect(deps.view.save).toHaveBeenCalledOnce();
    await runner.run(command({ name: "bogus", action: "bogus" }));
    expect(getNoticeMessages()).toContain("Unknown command: /bogus");
  });
});

describe("SlashRunner.reload", () => {
  it("puts templates last in the catalog and drops an older reload that finished after a newer one", async () => {
    const older = deferred<PromptTemplate[]>();
    const newer = deferred<PromptTemplate[]>();
    let calls = 0;
    const { runner, deps } = rig({ templates: () => (calls++ === 0 ? older.promise : newer.promise) });
    const first = runner.reload();
    const second = runner.reload();
    newer.resolve([template("newer")]);
    await second;
    older.resolve([template("older")]);
    await first;
    expect(deps.setCommands).toHaveBeenCalledOnce();
    const catalog = deps.setCommands.mock.calls[0]![0] as SlashCommand[];
    expect(catalog.at(-1)?.name).toBe("newer");
    expect(catalog.filter((c) => c.template).map((c) => c.name)).toEqual(["newer"]);
  });
});

describe("SlashRunner.watch", () => {
  it("registers four refs, reloads for files under the templates folder and ignores others", async () => {
    const { runner, deps, handlers } = rig();
    const registered: EventRef[] = [];
    runner.watch((ref) => registered.push(ref));
    await vi.waitFor(() => expect(deps.setCommands).toHaveBeenCalledTimes(1));
    expect(registered).toHaveLength(4);
    for (const event of ["create", "modify", "delete"]) {
      const before = deps.setCommands.mock.calls.length;
      handlers.get(event)!({ path: "Claude/Templates/a.md" });
      await vi.waitFor(() => expect(deps.setCommands.mock.calls.length).toBe(before + 1));
    }
    const settled = deps.setCommands.mock.calls.length;
    handlers.get("create")!({ path: "Elsewhere/a.md" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.setCommands.mock.calls.length).toBe(settled);
  });

  it("reloads on a rename when either path is inside the folder", async () => {
    const { runner, deps, handlers } = rig();
    runner.watch(() => undefined);
    await vi.waitFor(() => expect(deps.setCommands).toHaveBeenCalledTimes(1));
    handlers.get("rename")!({ path: "Elsewhere/a.md" }, "Claude/Templates/a.md");
    await vi.waitFor(() => expect(deps.setCommands).toHaveBeenCalledTimes(2));
    handlers.get("rename")!({ path: "Claude/Templates/b.md" }, "Elsewhere/b.md");
    await vi.waitFor(() => expect(deps.setCommands).toHaveBeenCalledTimes(3));
    handlers.get("rename")!({ path: "Elsewhere/c.md" }, "Elsewhere/d.md");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.setCommands).toHaveBeenCalledTimes(3);
  });

  it("invalidates an in-flight reload on dispose", async () => {
    const pending = deferred<PromptTemplate[]>();
    const { runner, deps } = rig({ templates: () => pending.promise });
    const reload = runner.reload();
    runner.dispose();
    pending.resolve([template("late")]);
    await reload;
    expect(deps.setCommands).not.toHaveBeenCalled();
  });
});
