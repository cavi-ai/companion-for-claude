import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { renderCompanionChrome } from "../../src/view/companionChrome";
import type { QuickOptionsState } from "../../src/view/quickOptions";

const snapshot = (): QuickOptionsState => ({
  chatBackend: "auto", chatModel: "Claude Sonnet 5", agentModeEnabled: false, vaultContextEnabled: true,
  memoryIngestOnSave: false, utilityBackend: "claude", sourceEnrichOnCreate: true,
  sourceInboxFolder: "Clippings", sourceCaptureEnabled: true, clipperStatus: "not-set-up",
  semanticEnabled: true, embeddingEngine: "builtin", embeddingModel: "EmbeddingGemma",
  embeddingHealth: "Ready", indexHealth: "Ready", memoryEnabled: true, memoryFolder: "Memory",
  memoryAutoConsolidate: true, discoveryEnabled: true, discoveryReranker: "current",
});

describe("renderCompanionChrome", () => {
  it("renders a page-specific options button and shared activity", () => {
    const root = new FakeElement();
    const activity = new ActivityStore();
    const dispose = renderCompanionChrome(root as unknown as HTMLElement, "related", "Related Notes", {
      app: new App(), activity, snapshot, save: vi.fn(), run: vi.fn(), openAllSettings: vi.fn(),
    });

    const trigger = root.querySelectorAll("button")
      .find((button) => button.getAttribute("aria-label") === "Quick options for Related Notes");
    expect(trigger).toBeDefined();
    expect(root.querySelector("h2")?.textContent).toBe("Related Notes");

    activity.start({ id: "index", kind: "semantic-index", title: "Building index", total: 2 });
    expect(root.querySelectorAll(".cc-activity-indicator")).toHaveLength(1);

    dispose();
    activity.update("index", { completed: 1 });
    expect(root.querySelectorAll(".cc-companion-chrome")).toHaveLength(0);
  });
});
