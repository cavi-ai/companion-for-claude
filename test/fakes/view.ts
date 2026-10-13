import { App, WorkspaceLeaf } from "obsidian";
import type ClaudeCompanionPlugin from "../../src/main";
import { OptimizeFeature, type OptimizeFeatureDeps } from "../../src/optimize/feature";
import { BuildView, type BuildViewDependencies } from "../../src/view/BuildView";
import { ChatView } from "../../src/view/ChatView";
import { InboxView } from "../../src/view/InboxView";
import { MemoryView } from "../../src/view/MemoryView";
import { ResearchView } from "../../src/view/ResearchView";
import { SystemView, type SystemViewDeps } from "../../src/view/SystemView";
import { buildPlugin } from "./plugin";

type Overrides = Record<string, unknown>;
type ResearchViewParams = ConstructorParameters<typeof ResearchView>;

const fail = (): never => {
  throw new Error("not wired in this test");
};

/** An object whose every method throws when called. */
const unwired = <T extends object>(): T =>
  new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : fail) }) as T;

/** Real instance through its constructor; `overrides` are assigned on top (private fields included). */
function withOverrides<T extends object>(instance: T, overrides: Overrides): T {
  return Object.assign(instance, overrides);
}

export function chatView(plugin: ClaudeCompanionPlugin = buildPlugin(), overrides: Overrides = {}, app: App = plugin.app): ChatView {
  return withOverrides(new ChatView(new WorkspaceLeaf(app), plugin), overrides);
}

export function inboxView(plugin: ClaudeCompanionPlugin = buildPlugin(), overrides: Overrides = {}): InboxView {
  return withOverrides(new InboxView(new WorkspaceLeaf(plugin.app), plugin), overrides);
}

export function memoryView(plugin: ClaudeCompanionPlugin = buildPlugin(), overrides: Overrides = {}): MemoryView {
  return withOverrides(new MemoryView(new WorkspaceLeaf(plugin.app), plugin), overrides);
}

const inertSystemDeps: SystemViewDeps = {
  scan: fail,
  safeFixes: fail,
  openNote: fail,
  openResearchDesk: fail,
  buildIndex: fail,
  catchUpIndex: fail,
  openInbox: fail,
  reviewSafeFixes: fail,
  reviewTagMerges: fail,
  connectOrphans: fail,
  typeUntypedNotes: fail,
  openSetupWizard: fail,
  openSettings: fail,
  openClipperSetup: fail,
  runActivityRecovery: fail,
};

export function systemView(plugin: ClaudeCompanionPlugin = buildPlugin(), deps: SystemViewDeps = inertSystemDeps, overrides: Overrides = {}): SystemView {
  return withOverrides(new SystemView(new WorkspaceLeaf(plugin.app), plugin, deps), overrides);
}

const inertBuildDeps: BuildViewDependencies = {
  getRun: fail,
  subscribe: fail,
  start: fail,
  pause: fail,
  resume: fail,
  cancel: fail,
  openSpec: fail,
  openTracker: fail,
  openSession: fail,
};

export function buildView(deps: BuildViewDependencies = inertBuildDeps, overrides: Overrides = {}, app: App = new App()): BuildView {
  return withOverrides(new BuildView(new WorkspaceLeaf(app), deps), overrides);
}

const inertResearchDeps: ResearchViewParams[2] = {
  actions: unwired(),
  askResearch: fail,
  openPath: fail,
  webSearchEnabled: fail,
};

export function researchView(
  repository: ResearchViewParams[1] = unwired(),
  deps: ResearchViewParams[2] = inertResearchDeps,
  overrides: Overrides = {},
  app: App = new App(),
): ResearchView {
  return withOverrides(new ResearchView(new WorkspaceLeaf(app), repository, deps), overrides);
}

export function optimizeFeature(deps: Partial<OptimizeFeatureDeps> = {}, overrides: Overrides = {}): OptimizeFeature {
  const inert: OptimizeFeatureDeps = {
    app: new App(),
    settings: fail,
    activity: fail,
    indexer: fail,
    ontology: fail,
    orderTagTriggers: fail,
    router: fail,
    isMobile: false,
    passiveUtilitySelection: fail,
    assertActive: fail,
    getState: fail,
    setState: fail,
  };
  return withOverrides(new OptimizeFeature({ ...inert, ...deps }), overrides);
}
