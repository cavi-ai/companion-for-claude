import { App, FakeElement, getLastOpenedModal } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { HeaderControls, type HeaderControlsDeps } from "../../src/view/chat/HeaderControls";
import type { HeaderHost } from "../../src/view/chat/hosts";
import type { ChatSession } from "../../src/view/chat/chatSession";
import { DEFAULT_SETTINGS } from "../../src/types";
import { defaultChatControls } from "../../src/claude/chatControls";

function setup(backend: "codex-cli" | "opencode-cli") {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: backend, codexModel: "model-a", opencodeModel: "provider/model-a" };
  const models = backend === "codex-cli" ? [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }] : [{ id: "provider/model-a", label: "provider/model-a" }, { id: "provider/model-b", label: "provider/model-b" }];
  const provider = { label: backend === "codex-cli" ? "Codex" : "OpenCode", listModels: async () => models, modelLabel: (id: string) => models.find(m => m.id === id)?.label ?? id };
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
    const modal = getLastOpenedModal() as unknown as { getItems(): { id: string; label: string }[] };
    expect(modal.getItems()).toEqual(expect.arrayContaining([{ id: "", label: "Codex default" }, { id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }]));
  });
});
