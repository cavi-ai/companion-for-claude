import { CLAUDE_MODELS, modelLabel, resolveModelId } from "../../claude/models";
import { DEVICE_MODELS } from "../../device/models";
import { mergeDetectedModels } from "../../providers/localModels";
import { chatBackendForRuntime } from "../../providers/runtimeBackend";
import type { CliBackendId } from "../../providers/router";
import type { CliModel } from "../../cli/modelDiscovery";
import type { PluginSettings } from "../../types";
import { cliModelChoices } from "../cliModelChoices";
import type { ComposerHost } from "./hosts";

export interface ModelChoice { value: string; label: string }
export interface ModelChoiceGroup { backend: PluginSettings["chatBackend"]; label: string; choices: ModelChoice[] }
export interface ModelDiscovery { ollama?: string[]; endpoint?: string[]; codex?: CliModel[]; opencode?: CliModel[] }

export const MODEL_BACKEND_LABELS: Record<PluginSettings["chatBackend"], string> = {
  auto: "Auto", claude: "Claude API", "claude-cli": "Claude Code", "codex-cli": "Codex", "opencode-cli": "OpenCode",
  local: "Ollama", custom: "Endpoint", device: "On-device GPU",
};

export function selectedModelValue(settings: PluginSettings, claudeModel: string, isMobile: boolean): string {
  const backend = chatBackendForRuntime(settings.chatBackend, isMobile);
  switch (backend) {
    case "codex-cli": return `codex-cli:${settings.codexModel}`;
    case "opencode-cli": return `opencode-cli:${settings.opencodeModel}`;
    case "device": return `device:${settings.deviceChatModel}`;
    case "local": return `ollama:${settings.ollamaModel}`;
    case "custom": return `custom:${settings.openaiCompatModel}`;
    default: return `${backend}:${claudeModel}`;
  }
}

/** One route-explicit catalog for both the header picker and composer select. */
export function modelCatalog(input: {
  settings: PluginSettings; claudeModel: string; isMobile: boolean;
  availableCli?: CliBackendId[]; detected?: ModelDiscovery;
}): ModelChoiceGroup[] {
  const { settings, claudeModel, isMobile } = input;
  const detected = input.detected ?? {};
  const claude = new Map(CLAUDE_MODELS.map(model => [model.id, model.label]));
  const configured = resolveModelId(settings.model, settings.customModel);
  if (configured && !claude.has(configured)) claude.set(configured, modelLabel(configured));
  if (claudeModel && !claude.has(claudeModel)) claude.set(claudeModel, modelLabel(claudeModel));
  const group = (backend: ModelChoiceGroup["backend"], choices: ModelChoice[]): ModelChoiceGroup => ({ backend, label: MODEL_BACKEND_LABELS[backend], choices });
  const claudeChoices = (backend: "auto" | "claude" | "claude-cli"): ModelChoice[] => [...claude].map(([id, label]) => ({ value: `${backend}:${id}`, label }));
  const groups = [group("auto", claudeChoices("auto")), group("claude", claudeChoices("claude"))];
  if (!isMobile) {
    for (const backend of ["claude-cli", "codex-cli", "opencode-cli"] as const) {
      if (!input.availableCli?.includes(backend) && settings.chatBackend !== backend) continue;
      groups.push(group(backend, backend === "claude-cli" ? claudeChoices(backend) : cliModelChoices(
        backend === "codex-cli" ? detected.codex ?? [] : detected.opencode ?? [],
        backend === "codex-cli" ? settings.codexModel : settings.opencodeModel,
        MODEL_BACKEND_LABELS[backend],
      ).map(model => ({ value: `${backend}:${model.id}`, label: model.label }))));
    }
  }
  const local = mergeDetectedModels(detected.ollama ?? [], settings.ollamaModel);
  if (local.length) groups.push(group("local", local.map(id => ({ value: `ollama:${id}`, label: id }))));
  if (settings.openaiCompatHost.trim() || settings.chatBackend === "custom") {
    const endpoint = mergeDetectedModels(detected.endpoint ?? [], settings.openaiCompatModel);
    if (endpoint.length) groups.push(group("custom", endpoint.map(id => ({ value: `custom:${id}`, label: id }))));
  }
  groups.push(group("device", DEVICE_MODELS.map(model => ({ value: `device:${model.id}`, label: model.name }))));
  return groups;
}

/** Read-only discovery with an explicit consumer lifetime and live selection snapshot. */
export class ModelCatalogSource {
  private detected: ModelDiscovery = {};
  private disposed = false;
  private generation = 0;

  constructor(private plugin: Pick<ComposerHost, "router" | "settings">, private claudeModel: () => string, private isMobile: boolean) {}

  selected(): string { return selectedModelValue(this.plugin.settings, this.claudeModel(), this.isMobile); }

  snapshot(): ModelChoiceGroup[] {
    const router = this.plugin.router();
    const availableCli = ([
      ["claude-cli", router.claudeCli], ["codex-cli", router.codexCli], ["opencode-cli", router.opencodeCli],
    ] as const).filter(([, provider]) => provider?.available?.()).map(([id]) => id);
    return modelCatalog({ settings: this.plugin.settings, claudeModel: this.claudeModel(), isMobile: this.isMobile, availableCli, detected: this.detected });
  }

  async refresh(update: (groups: ModelChoiceGroup[]) => void, failed?: () => void): Promise<void> {
    const generation = ++this.generation;
    const router = this.plugin.router();
    const jobs: Promise<void>[] = [];
    const load = <K extends keyof ModelDiscovery>(key: K, read: () => Promise<NonNullable<ModelDiscovery[K]>>): void => {
      jobs.push((async () => {
        try {
          const models = await read();
          if (this.disposed || generation !== this.generation) return;
          this.detected[key] = models;
          update(this.snapshot());
        } catch { if (!this.disposed && generation === this.generation) failed?.(); }
      })());
    };
    if (router.ollama?.listModels) load("ollama", () => router.ollama.listModels());
    if (this.plugin.settings.openaiCompatHost.trim() && router.openaiCompat?.listModels) load("endpoint", () => router.openaiCompat.listModels());
    if (!this.isMobile) {
      if (router.codexCli?.available?.()) load("codex", () => router.codexCli.listModels());
      if (router.opencodeCli?.available?.()) load("opencode", () => router.opencodeCli.listModels());
    }
    await Promise.all(jobs);
  }

  dispose(): void { this.disposed = true; ++this.generation; }
}
