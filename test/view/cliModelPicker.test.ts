import { App, FakeElement, getLastOpenedModal } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { HeaderControls, type HeaderControlsDeps } from "../../src/view/chat/HeaderControls";
import type { HeaderHost } from "../../src/view/chat/hosts";
import type { ChatSession } from "../../src/view/chat/chatSession";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { defaultChatControls } from "../../src/claude/chatControls";

function setup(backend: "codex-cli" | "opencode-cli") {
  const settings: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: backend, codexModel: "model-a", opencodeModel: "provider/model-a" };
  const models = backend === "codex-cli" ? [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }] : [{ id: "provider/model-a", label: "provider/model-a" }, { id: "provider/model-b", label: "provider/model-b" }];
  const provider = { available: () => true, label: backend === "codex-cli" ? "Codex" : "OpenCode", listModels: async () => models, modelLabel: (id: string) => models.find(m => m.id === id)?.label ?? id };
  const router = {
    codexCli: provider, opencodeCli: provider,
    chatProvider: () => ({ provider: { id: settings.chatBackend }, model: settings.chatBackend === "codex-cli" ? settings.codexModel : settings.opencodeModel }),
    chatCapabilities: () => ({ cli: true, local: false }),
    chatToolCapable: async () => false, chatReasoningActive: async () => false,
  };
  const plugin = { settings, router: () => router, saveSettings: vi.fn(async () => {}) } as unknown as HeaderHost;
  const chat = { controls: defaultChatControls(DEFAULT_SETTINGS.model), mode: { setCapable: () => {} } } as unknown as ChatSession;
  const deps = { renderKnobs: () => {}, showReasoning: () => {}, openSettings: vi.fn() } as unknown as HeaderControlsDeps;
  const header = new HeaderControls(new App() as never, plugin, chat, deps);
  header.modelLabelEl = new FakeElement("span") as unknown as HTMLElement;
  vi.spyOn(header, "updateUsageBar").mockImplementation(() => {});
  return { header, settings, chat, plugin };
}

describe("CLI chat model picker", () => {
  it.each([
    ["claude", "anthropic", DEFAULT_SETTINGS.model, "API", "Claude API", "Claude Sonnet 5.5"],
    ["device", "device", "qwen3-0.6b", "On-device", "On-device GPU", "Qwen3 0.6B"],
  ] as const)("keeps the %s header identity concise and its accessible label explicit", (backend, id, model, prefix, full, label) => {
    const { header, settings, plugin } = setup("codex-cli");
    settings.chatBackend = backend;
    plugin.router().chatProvider = () => ({ provider: { id }, model }) as ReturnType<ReturnType<HeaderHost["router"]>["chatProvider"]>;
    header.backendPillEl = new FakeElement("span") as unknown as HTMLElement;
    header.refreshModelLabel();
    expect(header.backendPillEl.textContent).toBe(prefix);
    expect(header.modelLabelEl.getAttribute("aria-label")).toBe(`Choose model and backend: ${full} · ${label}`);
  });
  it.each([
    ["ollama", "local-qwen", "Auto · Ollama", "Local Qwen"],
    ["anthropic", DEFAULT_SETTINGS.model, "Auto · API", "Claude Sonnet 5.5"],
  ])("names the resolved %s provider and model while Auto remains selected", (id, model, prefix, label) => {
    const { header, settings, chat, plugin } = setup("codex-cli");
    settings.chatBackend = "auto";
    plugin.router().chatProvider = () => ({ provider: { id }, model }) as ReturnType<ReturnType<HeaderHost["router"]>["chatProvider"]>;
    header.backendPillEl = new FakeElement("span") as unknown as HTMLElement;
    header.refreshModelLabel();
    expect(header.backendPillEl.textContent).toBe(prefix);
    expect(header.modelLabelEl.textContent).toBe(label);
    expect(settings.chatBackend).toBe("auto");
    expect(chat.controls.model).toBe(DEFAULT_SETTINGS.model);
  });
  it.each(["codex-cli", "opencode-cli"] as const)("saves a %s model without altering the Claude model", async (backend) => {
    const { header, settings, chat, plugin } = setup(backend);
    const model = backend === "codex-cli" ? "model-b" : "provider/model-b";
    await header.onModelSelect(`${backend}:${model}`);
    expect(settings[backend === "codex-cli" ? "codexModel" : "opencodeModel"]).toBe(model);
    expect(settings.chatBackend).toBe(backend);
    expect(chat.controls.model).toBe(DEFAULT_SETTINGS.model);
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(header.modelLabelEl.textContent).toBe(backend === "codex-cli" ? "Model B" : "provider/model-b");
  });

  it("opens detected models in a searchable picker with the CLI default and current selection", async () => {
    const { header } = setup("codex-cli");
    header.openModelMenu();
    await new Promise<void>(resolve => setImmediate(resolve));
    const modal = getLastOpenedModal()!;
    const rows = (modal.contentEl as unknown as FakeElement).querySelectorAll("button");
    expect(rows.map(row => row.getAttribute("data-model-value"))).toEqual(expect.arrayContaining(["codex-cli:", "codex-cli:model-a", "codex-cli:model-b"]));
    expect(rows.find(row => row.getAttribute("data-model-value") === "codex-cli:model-a")?.getAttribute("aria-pressed")).toBe("true");
    expect(rows.find(row => row.getAttribute("data-model-value") === "codex-cli:model-b")?.querySelector(".cc-model-option-label")?.textContent).toBe("Model B");
  });

  it.each(["auto", "claude", "claude-cli"] as const)("selects an explicit %s route without collapsing it into another Claude backend", async backend => {
    const { header, settings, chat } = setup("codex-cli");
    await header.onModelSelect(`${backend}:claude-opus-4-6`);
    expect(settings.chatBackend).toBe(backend);
    expect(chat.controls.model).toBe("claude-opus-4-6");
    expect(settings.model).toBe("claude-opus-4-6");
  });

  it("keeps legacy bare Claude selections on the existing auto route", async () => {
    const { header, settings } = setup("codex-cli");
    await header.onModelSelect("claude-opus-4-6");
    expect(settings.chatBackend).toBe("auto");
  });
});
