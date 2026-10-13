import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ContextToggles } from "../src/types";
import { WORKFLOWS } from "../src/workflows/catalog";
import { buildPlugin } from "./fakes/plugin";

const OFF: ContextToggles = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

function harness() {
  const view = {
    submitPrompt: vi.fn(async () => undefined),
    enableVaultSearchForChat: vi.fn(),
    refreshModelLabel: vi.fn(),
  };
  const app = new App();
  (app.workspace as unknown as { getActiveViewOfType: () => null }).getActiveViewOfType = () => null;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.context = { ...OFF };
  const saveSettings = vi.fn(async () => undefined);
  const plugin = buildPlugin({ settings, saveSettings }, app);
  vi.spyOn(plugin.views(), "activateView").mockResolvedValue(view as never);
  return { plugin, view, saveSettings };
}

describe("one-shot commands leave the stored context defaults alone", () => {
  it("runWorkflow sends active note + vault search as a turn override", async () => {
    const { plugin, view, saveSettings } = harness();
    const wf = { ...WORKFLOWS[0]!, vaultSearch: true };
    await plugin.views().runWorkflow(wf);
    expect(view.submitPrompt).toHaveBeenCalledWith(wf.prompt, wf.name, expect.any(Number), { context: { activeNote: true, searchVault: true } });
    expect(plugin.settings.context).toEqual(OFF);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("runWorkflow without vault search overrides only the active note", async () => {
    const { plugin, view } = harness();
    const wf = { ...WORKFLOWS[0]!, vaultSearch: false };
    await plugin.views().runWorkflow(wf);
    expect(view.submitPrompt).toHaveBeenCalledWith(wf.prompt, wf.name, expect.any(Number), { context: { activeNote: true } });
    expect(plugin.settings.context).toEqual(OFF);
  });

  it("generatePlanFromNote overrides the active note for the turn", async () => {
    const { plugin, view, saveSettings } = harness();
    await plugin.research().generatePlanFromNote();
    expect(view.submitPrompt).toHaveBeenCalledWith(expect.any(String), "Generate an implementation plan from this note", expect.any(Number), { context: { activeNote: true } });
    expect(plugin.settings.context).toEqual(OFF);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("generateArtifactFromContext overrides active note + selection for the turn", async () => {
    const { plugin, view, saveSettings } = harness();
    await plugin.views().generateArtifactFromContext();
    expect(view.submitPrompt).toHaveBeenCalledWith(expect.any(String), "Turn my current note into an artifact", expect.any(Number), { context: { activeNote: true, selection: true } });
    expect(plugin.settings.context).toEqual(OFF);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("the ask-vault command turns vault search on for the active chat only", async () => {
    const { plugin, view, saveSettings } = harness();
    await (plugin as unknown as { enableVaultSearch(): Promise<void> }).enableVaultSearch();
    expect(view.enableVaultSearchForChat).toHaveBeenCalledOnce();
    expect(plugin.settings.context).toEqual(OFF);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
