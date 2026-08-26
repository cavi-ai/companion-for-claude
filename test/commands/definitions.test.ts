import { describe, expect, it, vi } from "vitest";
import { MarkdownView, TFile } from "obsidian";
import { companionCommands, type CommandActions } from "../../src/commands/definitions";

const ACTION_NAMES = [
  "openChat", "newChat", "generatePlanFromNote", "generateArtifactFromContext", "rewriteSelection",
  "enrichNote", "enableVaultSearch", "rebuildSemanticIndex", "openRelatedNotes", "openResearchDesk",
  "openResearchWorkbench", "triageClippings", "startResearchFromActiveNote", "showSemanticIndexStatus",
  "browseConversations", "deleteActiveConversation", "handoffToBuild", "markNoteAsPlan", "organizeClippings",
  "dispatchCloudSession", "pullCloudReplies", "reviewLinkSuggestions", "openWorkflowPicker",
  "createPromptTemplate", "openSessionPicker", "openMemoryView", "consolidateMemory", "enrichNoteAsSource",
  "openSourceInbox", "exportClipperTemplates", "seedOntology",
] as const;

interface Harness { actions: CommandActions; calls: Record<string, ReturnType<typeof vi.fn>> }

function harness(overrides: Partial<CommandActions> = {}): Harness {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ACTION_NAMES) calls[name] = vi.fn();
  const actions = {
    activeMarkdownFile: () => null,
    lastMarkdownFile: () => null,
    hasActiveConversation: () => false,
    sourceCaptureEnabled: () => false,
    ontologyEnabled: () => false,
    desktop: true,
    ...calls,
    ...overrides,
  } as unknown as CommandActions;
  return { actions, calls };
}

const byId = (actions: CommandActions, id: string) => {
  const command = companionCommands(actions).find((c) => c.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command;
};

/** Run a command's check-style callback; returns what Obsidian would see. */
const check = (actions: CommandActions, id: string, checking: boolean): unknown =>
  byId(actions, id).checkCallback?.(checking);

function md(path = "note.md"): MarkdownView {
  const view = new MarkdownView() as MarkdownView & { file: TFile };
  view.file = new TFile(path, "", 0);
  return view;
}

describe("command surface", () => {
  it("registers unique ids", () => {
    const ids = companionCommands(harness().actions).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every command a name", () => {
    for (const command of companionCommands(harness().actions)) expect(command.name.length).toBeGreaterThan(0);
  });

  it("offers session capture only on desktop", () => {
    const ids = (desktop: boolean) => companionCommands(harness({ desktop }).actions).map((c) => c.id);
    expect(ids(true)).toContain("capture-session-memory");
    expect(ids(false)).not.toContain("capture-session-memory");
  });

  it("loses only session capture on mobile", () => {
    const desktop = companionCommands(harness({ desktop: true }).actions).map((c) => c.id);
    const mobile = companionCommands(harness({ desktop: false }).actions).map((c) => c.id);
    expect(desktop.filter((id) => !mobile.includes(id))).toEqual(["capture-session-memory"]);
  });
});

describe("plain commands", () => {
  it.each([
    ["open-chat", "openChat"],
    ["new-chat", "newChat"],
    ["artifact-from-selection", "generateArtifactFromContext"],
    ["ask-vault", "enableVaultSearch"],
    ["rebuild-semantic-index", "rebuildSemanticIndex"],
    ["open-related-notes", "openRelatedNotes"],
    ["open-research-desk", "openResearchDesk"],
    ["open-research-workbench", "openResearchWorkbench"],
    ["triage-clippings", "triageClippings"],
    ["semantic-index-status", "showSemanticIndexStatus"],
    ["browse-conversations", "browseConversations"],
    ["organize-clippings", "organizeClippings"],
    ["dispatch-cloud-session", "dispatchCloudSession"],
    ["pull-cloud-replies", "pullCloudReplies"],
    ["review-link-suggestions", "reviewLinkSuggestions"],
    ["open-workflows", "openWorkflowPicker"],
    ["create-prompt-template", "createPromptTemplate"],
    ["capture-session-memory", "openSessionPicker"],
    ["open-memory-view", "openMemoryView"],
    ["consolidate-memory", "consolidateMemory"],
    ["open-source-inbox", "openSourceInbox"],
  ])("%s runs %s and nothing else", (id, action) => {
    const h = harness();
    byId(h.actions, id).callback?.();
    for (const [name, fn] of Object.entries(h.calls)) {
      expect(fn, `${id} -> ${name}`).toHaveBeenCalledTimes(name === action ? 1 : 0);
    }
  });
});

describe("commands scoped to the active note", () => {
  it.each([
    ["plan-from-note", "generatePlanFromNote"],
    ["enrich-note", "enrichNote"],
    ["build-from-plan", "handoffToBuild"],
    ["mark-note-as-plan", "markNoteAsPlan"],
  ])("%s is unavailable without one", (id) => {
    expect(check(harness().actions, id, true)).toBe(false);
  });

  it.each([
    ["plan-from-note", "generatePlanFromNote"],
    ["enrich-note", "enrichNote"],
    ["build-from-plan", "handoffToBuild"],
    ["mark-note-as-plan", "markNoteAsPlan"],
  ])("%s runs %s once a note is active", (id, action) => {
    const file = new TFile("note.md", "", 0);
    const h = harness({ activeMarkdownFile: () => file });
    expect(check(h.actions, id, true)).toBe(true);
    check(h.actions, id, false);
    expect(h.calls[action]).toHaveBeenCalledTimes(1);
  });

  it("passes the file to the commands that act on one", () => {
    const file = new TFile("note.md", "", 0);
    const h = harness({ activeMarkdownFile: () => file });
    check(h.actions, "enrich-note", false);
    check(h.actions, "mark-note-as-plan", false);
    expect(h.calls.enrichNote).toHaveBeenCalledWith(file);
    expect(h.calls.markNoteAsPlan).toHaveBeenCalledWith(file);
  });
});

describe("research from the active note", () => {
  it("falls back to the last markdown file when focus moved to the desk", () => {
    const h = harness({ lastMarkdownFile: () => new TFile("last.md", "", 0) });
    expect(check(h.actions, "research-from-active-note", true)).toBe(true);
    check(h.actions, "research-from-active-note", false);
    expect(h.calls.startResearchFromActiveNote).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when no note has ever been open", () => {
    expect(check(harness().actions, "research-from-active-note", true)).toBe(false);
  });
});

describe("setting-gated commands", () => {
  it.each([
    ["delete-active-conversation", "hasActiveConversation", "deleteActiveConversation"],
    ["export-clipper-templates", "sourceCaptureEnabled", "exportClipperTemplates"],
    ["seed-ontology", "ontologyEnabled", "seedOntology"],
  ])("%s follows %s", (id, gate, action) => {
    expect(check(harness().actions, id, true)).toBe(false);
    const h = harness({ [gate]: () => true } as Partial<CommandActions>);
    expect(check(h.actions, id, true)).toBe(true);
    check(h.actions, id, false);
    expect(h.calls[action]).toHaveBeenCalledTimes(1);
  });

  it("requires both source capture and a note before enriching one as a source", () => {
    const file = new TFile("clip.md", "", 0);
    expect(check(harness({ sourceCaptureEnabled: () => true }).actions, "enrich-note-as-source", true)).toBe(false);
    expect(check(harness({ activeMarkdownFile: () => file }).actions, "enrich-note-as-source", true)).toBe(false);
    const h = harness({ sourceCaptureEnabled: () => true, activeMarkdownFile: () => file });
    expect(check(h.actions, "enrich-note-as-source", true)).toBe(true);
    check(h.actions, "enrich-note-as-source", false);
    expect(h.calls.enrichNoteAsSource).toHaveBeenCalledWith(file);
  });
});

describe("rewrite selection", () => {
  const editor = (selection: string) => ({ getSelection: () => selection }) as unknown as Parameters<
    NonNullable<ReturnType<typeof companionCommands>[number]["editorCheckCallback"]>
  >[1];

  const run = (h: Harness, selection: string, view: unknown, checking: boolean): unknown =>
    byId(h.actions, "rewrite-selection").editorCheckCallback?.(checking, editor(selection), view as MarkdownView);

  it("is unavailable with an empty or whitespace selection", () => {
    expect(run(harness(), "", md(), true)).toBe(false);
    expect(run(harness(), "   \n ", md(), true)).toBe(false);
  });

  it("is unavailable outside a markdown view", () => {
    expect(run(harness(), "text", {}, true)).toBe(false);
  });

  it("is unavailable when the markdown view has no file", () => {
    expect(run(harness(), "text", new MarkdownView(), true)).toBe(false);
  });

  it("rewrites the selection with the editor and view", () => {
    const h = harness();
    const view = md();
    expect(run(h, "text", view, true)).toBe(true);
    run(h, "text", view, false);
    expect(h.calls.rewriteSelection).toHaveBeenCalledTimes(1);
    expect(h.calls.rewriteSelection.mock.calls[0]?.[1]).toBe(view);
  });
});
