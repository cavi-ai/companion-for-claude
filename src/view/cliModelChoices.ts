import type { CliModel } from "../cli/modelDiscovery";

export function cliModelChoices(models: CliModel[], configured: string, label: string): CliModel[] {
  const choices = new Map<string, CliModel>([["", { id: "", label: `${label} default` }]]);
  for (const model of models) if (model.id.trim()) choices.set(model.id, model);
  const current = configured.trim();
  if (current && !choices.has(current)) choices.set(current, { id: current, label: `${current} (current)` });
  return [...choices.values()];
}
