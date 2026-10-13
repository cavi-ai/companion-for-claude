import { Platform, type DropdownComponent, type SettingGroupItem, type TextComponent } from "obsidian";
import type { CliBackend } from "../cli/backends/types";
import type { CliModel } from "../cli/modelDiscovery";
import { cliModelChoices } from "../view/cliModelChoices";
import type { ConnectionItemsContext } from "./connection";

const CUSTOM = "__companion_custom_model__";

export function cliModelItem(ctx: ConnectionItemsContext, backend: CliBackend, key: "codexModel" | "opencodeModel"): SettingGroupItem {
  const { plugin } = ctx;
  return {
    name: `${backend.label} model`,
    visible: () => !Platform.isMobile && (plugin.settings.chatBackend === backend.id || plugin.settings.settingsShowAdvanced),
    desc: `Choose a model detected by ${backend.label}, keep its default, or enter a custom model ID.`,
    render: (setting) => {
      const provider = key === "codexModel" ? plugin.router().codexCli : plugin.router().opencodeCli;
      let models: CliModel[] = [];
      let dropdown: DropdownComponent;
      let custom: TextComponent;
      const fill = (): void => {
        dropdown.selectEl.empty();
        for (const model of cliModelChoices(models, plugin.settings[key], backend.label)) dropdown.addOption(model.id, model.label);
        dropdown.addOption(CUSTOM, "Custom model…").setValue(plugin.settings[key]);
      };
      setting.addDropdown((component) => {
        dropdown = component;
        dropdown.selectEl.setAttr("aria-label", `${backend.label} model`);
        fill();
        dropdown.onChange(async (value) => {
          if (value === CUSTOM) { custom.inputEl.hidden = false; custom.inputEl.focus(); return; }
          custom.inputEl.hidden = true;
          custom.setValue(value);
          plugin.settings[key] = value;
          await plugin.saveSettings();
          plugin.refreshViews();
        });
      });
      setting.addText((component) => {
        custom = component;
        custom.setPlaceholder("Custom model ID").setValue(plugin.settings[key]);
        custom.inputEl.setAttr("aria-label", `Custom ${backend.label} model ID`);
        custom.inputEl.hidden = true;
        custom.onChange(async (value) => {
          plugin.settings[key] = value.trim();
          fill();
          await plugin.saveSettings();
          plugin.refreshViews();
        });
      });
      const status = setting.descEl.createDiv({ cls: "cc-cli-model-status" });
      setting.addButton((button) => {
        const load = async (refresh = false): Promise<void> => {
          button.setDisabled(true);
          status.setText("Detecting models…");
          try {
            models = await provider.listModels(refresh);
            fill();
            status.setText(models.length ? `${models.length} models detected.` : "No models detected. Use the CLI default or a custom model ID.");
          } catch (error) {
            status.setText(`Couldn’t detect models: ${error instanceof Error ? error.message : String(error)}`);
          } finally { button.setDisabled(false); }
        };
        button.setButtonText("Refresh").onClick(() => load(true));
        void load();
      });
    },
  };
}
