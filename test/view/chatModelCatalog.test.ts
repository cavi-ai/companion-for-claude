import { App, FakeElement, fakeDocument } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import { modelCatalog, selectedModelValue, ModelCatalogSource } from "../../src/view/chat/modelCatalog";
import { ModelPickerModal } from "../../src/view/ModelPickerModal";
import { reconcileModelOptions } from "../../src/view/chat/cliModelOptions";
import type { ComposerHost } from "../../src/view/chat/hosts";

const cli = ["claude-cli", "codex-cli", "opencode-cli"] as const;

describe("shared backend and model catalog", () => {
  it.each(["auto", "claude", "claude-cli", "codex-cli", "opencode-cli", "local", "custom", "device"] as const)("keeps all configured routes reachable from %s", (chatBackend) => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend, openaiCompatHost: "http://model.example/v1", openaiCompatModel: "my/endpoint", codexModel: "my-codex", opencodeModel: "provider/custom", ollamaModel: "my-ollama" };
    const groups = modelCatalog({ settings, claudeModel: "custom-claude", isMobile: false, availableCli: [...cli] });
    expect(groups.map(group => group.backend)).toEqual(["auto", "claude", ...cli, "local", "custom", "device"]);
    const values = groups.flatMap(group => group.choices.map(choice => choice.value));
    expect(values).toContain(selectedModelValue(settings, "custom-claude", false));
    expect(values).toContain("codex-cli:my-codex");
    expect(values).toContain("opencode-cli:provider/custom");
    expect(values).toContain("custom:my/endpoint");
    expect(values).toContain("claude-cli:custom-claude");
  });

  it("merges detected values with configured models without duplicates", () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), codexModel: "configured", openaiCompatHost: "http://model.example/v1", openaiCompatModel: "configured-endpoint" };
    const groups = modelCatalog({ settings, claudeModel: DEFAULT_SETTINGS.model, isMobile: false, availableCli: [...cli], detected: { codex: [{ id: "detected", label: "Detected model" }], endpoint: ["detected-endpoint", "detected-endpoint"] } });
    expect(groups.find(group => group.backend === "codex-cli")?.choices.map(choice => choice.value)).toEqual(["codex-cli:", "codex-cli:detected", "codex-cli:configured"]);
    expect(groups.find(group => group.backend === "custom")?.choices.map(choice => choice.value)).toEqual(["custom:configured-endpoint", "custom:detected-endpoint"]);
  });

  it("retains a configured custom Claude model after choosing another model for this chat", () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), model: "custom", customModel: "gateway/custom-claude" };
    const groups = modelCatalog({ settings, claudeModel: DEFAULT_SETTINGS.model, isMobile: false });
    expect(groups.find(group => group.backend === "auto")?.choices.map(choice => choice.value)).toContain("auto:gateway/custom-claude");
  });

  it("omits desktop-only routes on mobile without rewriting the synced setting", () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: "codex-cli" as const };
    const groups = modelCatalog({ settings, claudeModel: DEFAULT_SETTINGS.model, isMobile: true, availableCli: [...cli] });
    expect(groups.some(group => group.backend.endsWith("-cli"))).toBe(false);
    expect(selectedModelValue(settings, DEFAULT_SETTINGS.model, true)).toBe(`claude:${DEFAULT_SETTINGS.model}`);
    expect(settings.chatBackend).toBe("codex-cli");
  });

  it("keeps the native selector and current route while asynchronous catalogs arrive", () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: "codex-cli" as const, codexModel: "configured" };
    const select = new FakeElement("select") as unknown as HTMLSelectElement;
    const first = modelCatalog({ settings, claudeModel: DEFAULT_SETTINGS.model, isMobile: false, availableCli: [...cli] });
    reconcileModelOptions(select, first, "codex-cli:configured");
    const option = (select as unknown as FakeElement).querySelectorAll("option").find(node => node.getAttribute("value") === "codex-cli:configured")!;
    (select as unknown as FakeElement).focus();
    reconcileModelOptions(select, modelCatalog({ settings, claudeModel: DEFAULT_SETTINGS.model, isMobile: false, availableCli: [...cli], detected: { codex: [{ id: "new", label: "New model" }] } }), "codex-cli:configured");
    expect(select.value).toBe("codex-cli:configured");
    expect((select as unknown as FakeElement).querySelectorAll("option")).toContain(option);
    expect(fakeDocument.activeElement).toBe(select);
  });

  it("does not publish discovery results after the consumer closes", async () => {
    let finish!: (models: { id: string; label: string }[]) => void;
    const plugin = { settings: structuredClone(DEFAULT_SETTINGS), router: () => ({ codexCli: { available: () => true, listModels: () => new Promise(resolve => { finish = resolve; }) } }) } as unknown as ComposerHost;
    const source = new ModelCatalogSource(plugin, () => DEFAULT_SETTINGS.model, false);
    const update = vi.fn();
    const done = source.refresh(update);
    source.dispose();
    finish([{ id: "late", label: "Late model" }]);
    await done;
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the focused picker row during discovery and guards closed dialogs", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const source = new ModelCatalogSource({ settings, router: () => ({}) } as unknown as ComposerHost, () => DEFAULT_SETTINGS.model, false);
    const modal = new ModelPickerModal(new App(), source, vi.fn(), vi.fn());
    modal.open();
    const content = modal.contentEl as unknown as FakeElement;
    const current = content.querySelectorAll("button").find(node => node.getAttribute("data-model-value") === `auto:${DEFAULT_SETTINGS.model}`)!;
    expect(current).toBeTruthy();
    current.focus();
    modal.renderCatalog(source.snapshot());
    expect(content.querySelectorAll("button")).toContain(current);
    expect(fakeDocument.activeElement).toBe(current);
    modal.close();
    modal.renderCatalog(source.snapshot());
    expect(content.children).toHaveLength(0);
  });

  it("lets keyboard search select a backend without losing the route", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const source = new ModelCatalogSource({ settings, router: () => ({ codexCli: { available: () => true, listModels: async () => [] } }) } as unknown as ComposerHost, () => DEFAULT_SETTINGS.model, false);
    const choose = vi.fn();
    const modal = new ModelPickerModal(new App(), source, choose, vi.fn());
    modal.open();
    const search = (modal.contentEl as unknown as FakeElement).querySelector("input")!;
    search.value = "Codex";
    search.dispatchEvent({ type: "input" });
    search.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
    expect(choose).toHaveBeenCalledWith("codex-cli:");
  });
});
