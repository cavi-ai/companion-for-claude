import { Platform } from "obsidian";
import { selectedModelValue, type ModelChoiceGroup } from "./modelCatalog";
import type { ComposerHost } from "./hosts";

/** Header and composer selections stay aligned without rebuilding the focused dropdown. */
export function syncModelSelection(controls: HTMLElement, settings: ComposerHost["settings"], claudeModel: string): void {
  const select = controls.querySelector<HTMLSelectElement>(".cc-ctl-model select")
    ?? controls.querySelector<HTMLElement>(".cc-ctl-model")?.querySelector<HTMLSelectElement>("select");
  if (!select) return;
  select.value = selectedModelValue(settings, claudeModel, Platform.isMobile);
}

/** Retain the native select, groups and options as discovery extends the shared catalog. */
export function reconcileModelOptions(select: HTMLSelectElement, groups: ModelChoiceGroup[], selected: string): void {
  const oldGroups = new Map([...select.querySelectorAll<HTMLOptGroupElement>("optgroup")].map(group => [group.getAttribute("data-backend"), group]));
  const values = new Set<string>();
  for (const group of groups) {
    const element = oldGroups.get(group.backend) ?? select.createEl("optgroup", { attr: { label: group.label, "data-backend": group.backend } });
    const oldOptions = new Map([...element.querySelectorAll<HTMLOptionElement>("option")].map(option => [option.getAttribute("value"), option]));
    for (const choice of group.choices) {
      values.add(choice.value);
      const option = oldOptions.get(choice.value) ?? element.createEl("option", { attr: { value: choice.value } });
      option.setText(choice.label);
    }
  }
  for (const option of [...select.querySelectorAll<HTMLOptionElement>("option")]) if (!values.has(option.getAttribute("value") ?? option.value)) option.remove();
  select.value = selected;
}
