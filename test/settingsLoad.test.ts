import { describe, expect, it } from "vitest";
import { App, FakeElement, openSettingTab } from "./fakes/obsidian";
import { resolveSettings, isNamespacedData } from "../src/settingsLoad";
import { DEFAULT_SETTINGS } from "../src/types";
import { ClaudeCompanionSettingTab } from "../src/settings";
import type ClaudeCompanionPlugin from "../src/main";

// The initial-release flat shape: data.json *was* the settings object, with
// keys that have since been renamed (localUtilityEnabled) or removed.
const LEGACY_FLAT = {
  apiKey: "sk-ant-api-old",
  model: "claude-sonnet-4-6",
  customModel: "",
  maxTokens: 4096,
  systemPrompt:
    "You are Claude, working inside the user's Obsidian vault. Be concise and precise. " +
    "When the user asks for a plan, report, diagram, or anything visual, prefer producing a single " +
    "self-contained HTML artifact in a ```claude-html code block using the provided design system.",
  artifactFolder: "Claude/Artifacts",
  chatFolder: "Claude/Chats",
  context: { activeNote: true, selection: false, linkedNotes: true, searchVault: false },
  contextCharBudget: 24000,
  maxContextNotes: 6,
  artifactHeight: 640,
  maxConversations: 200,
  ollamaHost: "http://localhost:11434",
  ollamaModel: "mistral",
  localUtilityEnabled: true,
  autoTagOnSave: true,
  artifactBaseTags: ["claude", "artifact"],
  chatBaseTags: ["claude", "chat"],
  mcpEnabled: true,
  mcpPort: 22360,
  mcpToken: "tok",
  mcpAllowWrites: false,
  mcpWriteFolder: "Claude/Inbox",
  semanticEnabled: true,
  embeddingModel: "nomic-embed-text",
};

describe("resolveSettings with legacy configs", () => {
  it("treats the flat shape as settings, not namespaced data", () => {
    expect(isNamespacedData(LEGACY_FLAT)).toBe(false);
    expect(isNamespacedData({ settings: { apiKey: "x" } })).toBe(true);
    expect(isNamespacedData(null)).toBe(false);
  });

  it("migrates a pre-engine, pre-utilityBackend flat config without losing user values", () => {
    const s = resolveSettings(LEGACY_FLAT);
    // Renamed keys map over.
    expect(s.utilityBackend).toBe("ollama"); // localUtilityEnabled: true
    expect(s.embeddingEngine).toBe("ollama"); // semanticEnabled: true, pre-engine
    // The exact legacy default prompt upgrades to the current default.
    expect(s.systemPrompt).toBe(DEFAULT_SETTINGS.systemPrompt);
    // User values survive untouched.
    expect(s.apiKey).toBe("sk-ant-api-old");
    expect(s.ollamaModel).toBe("mistral");
    expect(s.context).toEqual({ activeNote: true, selection: false, linkedNotes: true, searchVault: false });
    expect(s.artifactBaseTags).toEqual(["claude", "artifact"]);
    // New-feature defaults fill in.
    expect(s.mcpClientServers).toEqual([]);
    expect(s.discoveryMaxResults).toBe(DEFAULT_SETTINGS.discoveryMaxResults);
  });

  it("keeps a customized system prompt verbatim", () => {
    const s = resolveSettings({ systemPrompt: "My own prompt." });
    expect(s.systemPrompt).toBe("My own prompt.");
  });

  it("does not re-migrate configs that already have the new keys", () => {
    const s = resolveSettings({ settings: { utilityBackend: "claude", embeddingEngine: "builtin", localUtilityEnabled: true, semanticEnabled: true } as never });
    expect(s.utilityBackend).toBe("claude");
    expect(s.embeddingEngine).toBe("builtin");
  });

  it("renders the full settings tab against a migrated legacy config", async () => {
    (globalThis as Record<string, unknown>).activeDocument = {
      createDocumentFragment: () => new FakeElement("fragment"),
    };
    const plugin = {
      settings: resolveSettings(LEGACY_FLAT),
      saveSettings: async () => {},
      router: () => ({
        anthropic: { hasCredentials: () => true },
        ollama: { listModels: async () => [], capabilities: async () => [], test: async () => ({ ok: true, detail: "" }) },
        openaiCompat: { test: async () => ({ ok: true, detail: "" }) },
      }),
      externalMcp: () => ({ errorFor: () => null, test: async () => ({ ok: true }) }),
      mcpRunning: () => false,
      builtinModelCached: async () => false,
      builtinEmbedder: () => ({ backend: () => null, download: async () => {} }),
      indexer: () => undefined,
      ontology: () => undefined,
      clipperTemplatesStale: () => false,
      refreshViews: () => {},
      invalidateIndexer: () => {},
      loadOntologyOnStart: async () => {},
    } as unknown as ClaudeCompanionPlugin;
    const tab = new ClaudeCompanionSettingTab(new App() as never, plugin);
    expect(() => openSettingTab(tab)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const container = tab.containerEl as unknown as FakeElement;
    expect(container.querySelectorAll(".setting-item").length).toBeGreaterThan(50);
    // The migrated engine selection is what the dropdown shows.
    expect((plugin.settings as { embeddingEngine: string }).embeddingEngine).toBe("ollama");
  });
});
