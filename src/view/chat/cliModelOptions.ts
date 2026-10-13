import { cliModelChoices } from "../cliModelChoices";
import type { ComposerHost } from "./hosts";

/** Header and composer selections stay aligned without rebuilding the focused dropdown. */
export function syncModelSelection(controls: HTMLElement, settings: ComposerHost["settings"], claudeModel: string): void {
  const select = controls.querySelector<HTMLSelectElement>(".cc-ctl-model select");
  if (!select) return;
  const values: Partial<Record<typeof settings.chatBackend, string>> = {
    "codex-cli": `codex-cli:${settings.codexModel}`,
    "opencode-cli": `opencode-cli:${settings.opencodeModel}`,
    device: `device:${settings.deviceChatModel}`,
    local: `ollama:${settings.ollamaModel}`,
    custom: `custom:${settings.openaiCompatModel}`,
  };
  select.value = values[settings.chatBackend] ?? claudeModel;
}

/** The desktop dropdown shares the detected catalog with settings and the header. */
export async function appendCliModelOptions(select: HTMLSelectElement, plugin: Pick<ComposerHost, "router" | "settings">): Promise<void> {
  const router = plugin.router();
  const entries = [
    { id: "codex-cli" as const, key: "codexModel" as const, label: "Codex", provider: router.codexCli },
    { id: "opencode-cli" as const, key: "opencodeModel" as const, label: "OpenCode", provider: router.opencodeCli },
  ];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.provider?.available()) return;
    const group = select.createEl("optgroup", { attr: { label: entry.label } });
    const fill = (models: Parameters<typeof cliModelChoices>[0]): void => {
      group.empty();
      const current = plugin.settings[entry.key];
      for (const model of cliModelChoices(models, current, entry.label)) group.createEl("option", { value: `${entry.id}:${model.id}`, text: model.label });
      if (plugin.settings.chatBackend === entry.id) select.value = `${entry.id}:${current}`;
    };
    fill([]);
    try {
      const models = await entry.provider.listModels();
      if (select.isConnected) fill(models);
    } catch (error) { console.debug(`Claude Companion: ${entry.label} model discovery failed`, error); }
  }));
}
