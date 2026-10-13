import { describe, expect, it, vi, type Mock } from "vitest";
import { MarkdownView, Platform, TFile } from "obsidian";
import { buildCommandActions, type CommandActionsHost } from "../../src/composition/commands";
import type { CommandActions } from "../../src/commands/definitions";

const file = new TFile("notes/a.md", "", 0);
const editor = { id: "editor" } as never;
const view = new MarkdownView();

interface Rig { host: CommandActionsHost; actions: CommandActions; mocks: Record<string, Mock> }

function rig(): Rig {
  const mocks: Record<string, Mock> = {};
  const fn = (name: string, impl?: (...args: unknown[]) => unknown): Mock => (mocks[name] = vi.fn(impl));
  const group = (prefix: string, names: string[]): Record<string, Mock> =>
    Object.fromEntries(names.map((n) => [n, fn(`${prefix}.${n}`)]));
  const flat = (names: string[]): Record<string, Mock> => Object.fromEntries(names.map((n) => [n, fn(n)]));

  const semantic = group("semantic", ["rebuildSemanticIndex", "showSemanticIndexStatus"]);
  const memory = group("memory", ["openSessionPicker", "consolidateMemory"]);
  const enrichment = group("enrichment", ["runEnrich"]);
  const optimize = group("optimize", ["reviewTagMerges", "reviewOrphanLinks", "reviewUntypedNotes"]);
  const publish = group("publish", ["publishNote", "copyLink", "unpublish"]);
  const research = group("research", ["generatePlanFromNote", "activateResearchDesk", "startResearchFromActiveNote", "handoffToBuild", "markNoteAsPlan"]);
  const publishing = {
    ...group("publishing", ["dispatchCloudSession", "pullCloudReplies"]),
    publishedItems: fn("publishing.publishedItems", () => [{ key: "notes/a.md" }]),
  };
  const orders = group("orders", ["createStandingOrder", "pickStandingOrder"]);
  const clipperSetup = group("clipperSetup", ["exportTemplates"]);
  const onboarding = group("onboarding", ["seedOntology", "openSetupWizard"]);
  const views = group("views", [
    "openNewChatTab", "generateArtifactFromContext", "activateRelatedView", "openWorkflowPicker",
    "activateMemoryView", "activateInboxView", "activateSystem",
  ]);
  const noteFlows = group("noteFlows", ["enrichNoteFlow", "reviewLinkSuggestions", "suggestFrontmatterForActiveNote"]);
  const clearChat = fn("view.clearChat");
  views.activateView = fn("views.activateView", async () => ({ clearChat }));
  const host = {
    app: { workspace: { getActiveViewOfType: fn("workspace.getActiveViewOfType", () => ({ file })) } },
    settings: { sourceCaptureEnabled: true, ontologyEnabled: true },
    lastMarkdownFile: file,
    research: () => research,
    publishing: () => publishing,
    orders: () => orders,
    conversations: () => ({ getActive: fn("conversations.getActive", () => ({ id: "c" })) }),
    views: () => views,
    noteFlows: () => noteFlows,
    semantic: () => semantic,
    memory: () => memory,
    enrichment: () => enrichment,
    optimize: () => optimize,
    publish: () => publish,
    clipperSetup: () => clipperSetup,
    onboarding: () => onboarding,
    ...flat([
      "startInlineEdit", "enableVaultSearch", "triageClippingsWithPicker",
      "browseConversations", "deleteActiveConversation",
      "organizeClippings", "createPromptTemplate",
    ]),
  } as unknown as CommandActionsHost;
  return { host, actions: buildCommandActions(host), mocks };
}

const ignore = new Set(["workspace.getActiveViewOfType", "conversations.getActive"]);

type Row = [key: keyof CommandActions, args: unknown[], expected: Array<[mock: string, args?: unknown[]]>];

const ROWS: Row[] = [
  ["openChat", [], [["views.activateView", []]]],
  ["newChat", [], [["views.activateView", []], ["view.clearChat", []]]],
  ["newChatTab", [], [["views.openNewChatTab", []]]],
  ["generatePlanFromNote", [], [["research.generatePlanFromNote", []]]],
  ["generateArtifactFromContext", [], [["views.generateArtifactFromContext", []]]],
  ["editWithClaude", [editor, view], [["startInlineEdit", [editor, view]]]],
  ["enrichNote", [file], [["noteFlows.enrichNoteFlow", [file]]]],
  ["enableVaultSearch", [], [["enableVaultSearch", []]]],
  ["rebuildSemanticIndex", [], [["semantic.rebuildSemanticIndex", []]]],
  ["openRelatedNotes", [], [["views.activateRelatedView", []]]],
  ["openResearchDesk", [], [["research.activateResearchDesk", []]]],
  ["triageClippings", [], [["triageClippingsWithPicker", []]]],
  ["startResearchFromActiveNote", [], [["research.startResearchFromActiveNote", []]]],
  ["showSemanticIndexStatus", [], [["semantic.showSemanticIndexStatus", []]]],
  ["browseConversations", [], [["browseConversations", []]]],
  ["deleteActiveConversation", [], [["deleteActiveConversation", []]]],
  ["handoffToBuild", [], [["research.handoffToBuild", []]]],
  ["markNoteAsPlan", [file], [["research.markNoteAsPlan", [file]]]],
  ["organizeClippings", [], [["organizeClippings", []]]],
  ["dispatchCloudSession", [], [["publishing.dispatchCloudSession", []]]],
  ["pullCloudReplies", [], [["publishing.pullCloudReplies", []]]],
  ["reviewLinkSuggestions", [], [["noteFlows.reviewLinkSuggestions", []]]],
  ["openWorkflowPicker", [], [["views.openWorkflowPicker", []]]],
  ["suggestFrontmatterForActiveNote", [], [["noteFlows.suggestFrontmatterForActiveNote", []]]],
  ["createPromptTemplate", [], [["createPromptTemplate", []]]],
  ["createStandingOrder", [], [["orders.createStandingOrder", []]]],
  ["runStandingOrder", [], [["orders.pickStandingOrder", []]]],
  ["openSessionPicker", [], [["memory.openSessionPicker", []]]],
  ["openMemoryView", [], [["views.activateMemoryView", []]]],
  ["consolidateMemory", [], [["memory.consolidateMemory", []]]],
  ["enrichNoteAsSource", [file], [["enrichment.runEnrich", [file]]]],
  ["openSourceInbox", [], [["views.activateInboxView", []]]],
  ["openSystem", [], [["views.activateSystem", []]]],
  ["exportClipperTemplates", [], [["clipperSetup.exportTemplates", []]]],
  ["seedOntology", [], [["onboarding.seedOntology", []]]],
  ["optimizeBrain", [], [["optimize.reviewTagMerges", [expect.any(Function)]]]],
  ["optimizeLinks", [], [["optimize.reviewOrphanLinks", [expect.any(Function)]]]],
  ["optimizeTypes", [], [["optimize.reviewUntypedNotes", [expect.any(Function)]]]],
  ["openSetupWizard", [], [["onboarding.openSetupWizard", []]]],
  ["publishNote", [file], [["publish.publishNote", [file.path]]]],
  ["copyPublishedLink", [file], [["publish.copyLink", [file.path]]]],
  ["unpublishNote", [file], [["publish.unpublish", [file.path]]]],
];

const VALUE_KEYS = ["activeMarkdownFile", "lastMarkdownFile", "hasActiveConversation", "sourceCaptureEnabled", "ontologyEnabled", "desktop", "isPublished"];

describe("buildCommandActions", () => {
  it("covers every CommandActions key exactly once", () => {
    const { actions } = rig();
    const covered = [...ROWS.map(([key]) => key as string), ...VALUE_KEYS].sort();
    expect(covered).toEqual(Object.keys(actions).sort());
  });

  it.each(ROWS)("%s calls exactly its host member", async (key, args, expected) => {
    const { actions, mocks } = rig();
    await (actions[key] as (...a: unknown[]) => unknown)(...args);
    await Promise.resolve();
    await Promise.resolve();
    const called = Object.keys(mocks).filter((name) => !ignore.has(name) && mocks[name]!.mock.calls.length > 0).sort();
    expect(called).toEqual(expected.map(([name]) => name).sort());
    for (const [name, expectedArgs] of expected) {
      expect(mocks[name]).toHaveBeenCalledTimes(1);
      expect(mocks[name]).toHaveBeenCalledWith(...(expectedArgs ?? []));
    }
  });

  it("reads the active file through the markdown view lookup", () => {
    const { actions, mocks } = rig();
    expect(actions.activeMarkdownFile()).toBe(file);
    expect(mocks["workspace.getActiveViewOfType"]).toHaveBeenCalledWith(MarkdownView);
  });

  it("answers state queries from the host", () => {
    const { actions, host } = rig();
    expect(actions.lastMarkdownFile()).toBe(file);
    expect(actions.hasActiveConversation()).toBe(true);
    expect(actions.sourceCaptureEnabled()).toBe(true);
    expect(actions.ontologyEnabled()).toBe(true);
    expect(actions.desktop).toBe(!Platform.isMobile);
    expect(actions.isPublished(file)).toBe(true);
    expect(actions.isPublished(new TFile("other.md", "", 0))).toBe(false);
    expect(host.publishing().publishedItems()).toHaveLength(1);
  });

  it("returns the promise from flows the command layer awaits", async () => {
    const { actions, mocks } = rig();
    mocks["research.handoffToBuild"]!.mockResolvedValue("done");
    await expect(actions.handoffToBuild()).resolves.toBe("done");
  });
});
