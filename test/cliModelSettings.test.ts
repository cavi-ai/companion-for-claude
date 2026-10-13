import { DropdownComponent, FakeElement, Setting, TextComponent } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { connectionItems, type ConnectionItemsContext } from "../src/settingsItems/connection";
import { DEFAULT_SETTINGS } from "../src/types";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("detected CLI model settings", () => {
  it.each(["codex", "opencode"] as const)("automatically fills %s choices and saves selection without changing the backend", async (id) => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: `${id}-cli` };
    const listModels = vi.fn(async () => [{ id: "detected-model", label: "Detected model" }]);
    const plugin = { settings, router: () => ({ codexCli: { listModels }, opencodeCli: { listModels } }), saveSettings: vi.fn(async () => {}), refreshViews: () => {} };
    const ctx = { plugin, renderStatus: () => {}, storageBlurb: () => "" } as unknown as ConnectionItemsContext;
    const row = connectionItems(ctx).find((item) => item.name === `${id === "codex" ? "Codex" : "OpenCode"} model`)!;
    const setting = new Setting(new FakeElement("div"));
    row.render?.(setting as never);
    await tick();
    const dropdown = setting.components.find((component) => component instanceof DropdownComponent) as DropdownComponent;
    expect(dropdown).toBeDefined();
    expect(dropdown.options.get("detected-model")).toBe("Detected model");
    expect(dropdown.options.has("")).toBe(true);
    expect(settings[`${id}Model`]).toBe("");
    dropdown.simulateSelect("detected-model");
    await tick();
    expect(settings[`${id}Model`]).toBe("detected-model");
    expect(settings.chatBackend).toBe(`${id}-cli`);
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });

  it("retains a saved custom model when discovery fails", async () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), codexModel: "private-model" };
    const plugin = { settings, router: () => ({ codexCli: { listModels: async () => { throw new Error("CLI offline"); } } }), saveSettings: async () => {} };
    const row = connectionItems({ plugin } as unknown as ConnectionItemsContext).find((item) => item.name === "Codex model")!;
    const setting = new Setting(new FakeElement("div"));
    row.render?.(setting as never);
    await tick();
    const dropdown = setting.components.find((component) => component instanceof DropdownComponent) as DropdownComponent;
    expect(dropdown?.getValue()).toBe("private-model");
    expect(dropdown?.options.has("private-model")).toBe(true);
    expect(setting.components.some((component) => component instanceof TextComponent)).toBe(true);
    expect(settings.codexModel).toBe("private-model");
    expect(setting.descEl.querySelector(".cc-cli-model-status")?.textContent).toContain("CLI offline");
  });
});
