import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  FuzzySuggestModal: class {},
  PluginSettingTab: class {},
}));

import ClaudeCompanionPlugin from "../../src/main";
import type { Provider } from "../../src/providers/types";
import { DEFAULT_SETTINGS } from "../../src/types";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";
import type { IntelligenceFinding } from "../../src/research/intelligence";

const records: ResearchRecord[] = [
  { path: "P.md", title: "Project", type: "research-project", project: "P.md", question: "Does it work?", audience: "Researchers", stage: "reason", status: "active" },
  { path: "C.md", title: "Claim", type: "claim", project: "P.md", proposition: "It works", confidence: "moderate", reviewState: "reviewed", supports: [], challenges: [], contextualizes: [], limitations: [] },
];
const findings: IntelligenceFinding[] = [{
  id: "research-gap:unsupported:C.md", category: "research-gap", severity: "warning", confidence: "high",
  epistemicStatus: "observation", title: "Unsupported", rationale: "No support", paths: ["C.md"], verification: "Check it",
}];

function provider(id: "anthropic" | "ollama", calls: string[]): Provider {
  return {
    id,
    label: id,
    hasCredentials: () => true,
    stream: async () => undefined,
    complete: async () => {
      calls.push(id);
      return JSON.stringify({ briefing: "Brief", groups: [{ title: "Summary", insights: [{ text: "Review the claim", epistemicStatus: "observation", paths: ["C.md"] }] }] });
    },
    test: async () => ({ ok: true, detail: "ok" }),
  };
}

describe("research intelligence plugin wiring", () => {
  it("creates isolated view coordinators and unload cancels all of them", () => {
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    plugin.settings = { ...DEFAULT_SETTINGS };
    const first = plugin.createIntelligenceCoordinator(); const second = plugin.createIntelligenceCoordinator();
    expect(first).not.toBe(second);
    const firstCancel = vi.spyOn(first, "cancel"); const secondCancel = vi.spyOn(second, "cancel");
    first.cancel(); expect(secondCancel).not.toHaveBeenCalled();
    plugin.onunload(); expect(firstCancel).toHaveBeenCalled(); expect(secondCancel).toHaveBeenCalledOnce();
  });
  it("owns one coordinator whose dependencies resolve live settings and router values", async () => {
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    plugin.settings = { ...DEFAULT_SETTINGS, intelligenceNarrator: "disabled" };
    const calls: string[] = [];
    const anthropic = provider("anthropic", calls);
    const ollama = provider("ollama", calls);
    Object.defineProperty(plugin, "router", { value: () => ({
      anthropic,
      ollama,
      chatBackend: plugin.settings.chatBackend,
      localAvailable: async () => true,
      resolve: () => ({ provider: anthropic, model: "claude-one" }),
    }) });

    const coordinator = plugin.intelligenceCoordinator();
    const snapshot = buildProjectSnapshot("P.md", records, []);
    expect(plugin.intelligenceCoordinator()).toBe(coordinator);
    expect(coordinator.stateFor(snapshot, findings)).toEqual({ status: "disabled" });

    plugin.settings.intelligenceNarrator = "claude";
    plugin.settings.chatBackend = "claude";
    expect(await coordinator.analyze(snapshot, findings)).toEqual(expect.objectContaining({ status: "current", providerId: "anthropic" }));

    plugin.settings.intelligenceNarrator = "local";
    plugin.settings.ollamaModel = "local-two";
    expect(await coordinator.analyze(snapshot, findings)).toEqual(expect.objectContaining({ status: "current", providerId: "ollama", model: "local-two" }));
    expect(calls).toEqual(["anthropic", "ollama"]);
  });

  it("cancels and clears its coordinator on plugin unload", () => {
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    plugin.settings = { ...DEFAULT_SETTINGS };
    const coordinator = plugin.intelligenceCoordinator();
    const cancel = vi.spyOn(coordinator, "cancel");

    plugin.onunload();

    expect(cancel).toHaveBeenCalledOnce();
    expect(plugin.intelligenceCoordinator()).not.toBe(coordinator);
  });
});
