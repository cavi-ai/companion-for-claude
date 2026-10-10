// The Local models page of the settings tab: Ollama and OpenAI-compatible
// endpoint hosts, model pickers with Detect, connection tests, and the tag
// classifier backend.

import { Notice, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { mergeDetectedModels } from "../providers/localModels";
import type { ProviderStatus } from "../providers/types";

/** Models found by the last Detect, kept by the settings tab across re-renders. */
export interface DetectedModels {
  ollama: string[] | null;
  endpoint: string[] | null;
}

export interface LocalModelsItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "refreshViews" | "router" | "saveSettings" | "settings">;
  detected: DetectedModels;
  /** Re-render the settings page. */
  update(): void;
  renderStatus(el: HTMLElement, status: ProviderStatus): void;
}

export function localModelsItems(ctx: LocalModelsItemsContext): SettingGroupItem[] {
  const { plugin, detected } = ctx;
  return [
    {
      name: "Utility tasks backend",
      desc: "Summaries, auto-tagging, and ingestion go to this backend instead of Claude. Claude Code sign-in covers chat only. Background tasks (tagging, source enrichment, memory) need an API key or a local model.",
      control: { type: "dropdown", key: "utilityBackend", options: { claude: "Claude", ollama: "Ollama (local)", custom: "OpenAI-compatible endpoint" } },
    },
    { name: "Ollama host", desc: "Base URL of your local Ollama server.", control: { type: "text", key: "ollamaHost", placeholder: "http://localhost:11434" } },
    {
      name: "Local chat model",
      desc: "Choose a detected model, or type one (e.g. llama3.1, qwen2.5). Click Detect to refresh the list.",
      render: (setting) => {
        const models = detected.ollama;
        if (models && models.length > 0) {
          setting.addDropdown((dd) => {
            for (const m of models) dd.addOption(m, m);
            // Keep the current value selectable even if not in the detected list.
            if (!models.includes(plugin.settings.ollamaModel)) dd.addOption(plugin.settings.ollamaModel, `${plugin.settings.ollamaModel} (current)`);
            dd.setValue(plugin.settings.ollamaModel).onChange(async (v) => {
              plugin.settings.ollamaModel = v;
              await plugin.saveSettings();
            });
          });
        } else {
          setting.addText((text) =>
            text.setValue(plugin.settings.ollamaModel).onChange(async (v) => {
              plugin.settings.ollamaModel = v.trim() || "llama3.1";
              await plugin.saveSettings();
            }),
          );
        }
        setting.addButton((btn) =>
          btn
            .setButtonText("Detect")
            .setTooltip("Query the Ollama server for installed models")
            .onClick(async () => {
              await plugin.saveSettings();
              btn.setButtonText("Detecting…").setDisabled(true);
              const found = await plugin.router().ollama.listModels();
              detected.ollama = found;
              if (found.length === 0) {
                new Notice("No Ollama models detected. Is `ollama serve` running, and have you pulled a model?");
              } else {
                if (!found.includes(plugin.settings.ollamaModel)) {
                  const first = found[0];
                  if (first) plugin.settings.ollamaModel = first;
                  await plugin.saveSettings();
                }
                new Notice(`Detected ${found.length} model(s).`);
              }
              ctx.update(); // rebuild the row so the dropdown appears/updates
            }),
        );
        // Capability badges per detected model — tools gates the agent; thinking
        // means the model reasons before answering.
        const capsEl = setting.settingEl.createDiv({ cls: "cc-model-caps setting-item-description" });
        void (async () => {
          const listed = detected.ollama ?? [];
          if (listed.length === 0) return;
          const ollama = plugin.router().ollama;
          for (const m of listed) {
            const caps = await ollama.capabilities(m);
            const tools = caps.includes("tools");
            const thinking = caps.includes("thinking");
            const row = capsEl.createDiv({ cls: "cc-model-caps-row" });
            row.createSpan({ text: m, cls: "cc-model-caps-name" });
            row.createSpan({ text: `tools ${tools ? "✓" : "✗"}`, cls: tools ? "is-ok" : "is-err" });
            row.createSpan({ text: `thinking ${thinking ? "✓" : "✗"}`, cls: thinking ? "is-ok" : "" });
            if (!tools) row.createSpan({ text: " — chat only, no agent", cls: "setting-item-description" });
          }
        })();
      },
    },
    {
      name: "Test local connection",
      desc: "Checks that Ollama is reachable and lists pulled models.",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        setting.addButton((btn) =>
          btn.setButtonText("Test Ollama").onClick(async () => {
            await plugin.saveSettings();
            ctx.renderStatus(status, { ok: true, detail: "Testing…" });
            ctx.renderStatus(status, await plugin.router().ollama.test());
          }),
        );
      },
    },
    { name: "Utility model (optional)", desc: "A smaller model for utility tasks (tagging, summaries, ingestion). Empty = use the chat model above. A 1–3B model is plenty and much faster.", control: { type: "text", key: "ollamaUtilityModel" } },
    {
      name: "Tag classifier backend",
      desc: "Which model judges uncertain tag merges in Optimize brain. Tag names and note titles go to it. Ollama and endpoint choices never fall back to Claude.",
      control: { type: "dropdown", key: "classifierBackend", options: { utility: "Same as utility tasks", ollama: "Ollama (local)", custom: "OpenAI-compatible endpoint" } },
    },
    { name: "Tag classifier model (optional)", desc: "Model id for the classifier. Empty = the backend's configured model. Ignored when the backend is the same as utility tasks.", control: { type: "text", key: "classifierModel" } },
    { name: "Endpoint host", desc: "Base URL, with or without /v1 (e.g. http://localhost:1234).", control: { type: "text", key: "openaiCompatHost", placeholder: "http://localhost:1234" } },
    {
      name: "Endpoint model",
      desc: "Choose a model the server exposes, or type its id. Click Detect to refresh the list.",
      render: (setting) => {
        const models = detected.endpoint;
        if (models && models.length > 0) {
          setting.addDropdown((dd) => {
            const merged = mergeDetectedModels(models, plugin.settings.openaiCompatModel);
            for (const m of merged) dd.addOption(m, m);
            const current = plugin.settings.openaiCompatModel.trim() || merged[0] || "";
            dd.setValue(current).onChange(async (v) => {
              plugin.settings.openaiCompatModel = v;
              await plugin.saveSettings();
              plugin.refreshViews();
            });
          });
        } else {
          setting.addText((text) =>
            text.setValue(plugin.settings.openaiCompatModel).onChange(async (v) => {
              plugin.settings.openaiCompatModel = v.trim();
              await plugin.saveSettings();
              plugin.refreshViews();
            }),
          );
        }
        setting.addButton((btn) =>
          btn
            .setButtonText("Detect")
            .setTooltip("Query the endpoint for the models it serves")
            .onClick(async () => {
              await plugin.saveSettings();
              btn.setButtonText("Detecting…").setDisabled(true);
              const found = await plugin.router().openaiCompat.listModels();
              detected.endpoint = found;
              if (found.length === 0) {
                new Notice("No models detected. Check the endpoint host, and that the server has a model loaded.");
              } else {
                if (!found.includes(plugin.settings.openaiCompatModel)) {
                  const first = found[0];
                  if (first) plugin.settings.openaiCompatModel = first;
                  await plugin.saveSettings();
                }
                new Notice(`Detected ${found.length} model(s).`);
              }
              plugin.refreshViews();
              ctx.update();
            }),
        );
      },
    },
    {
      name: "Endpoint API key",
      desc: "Optional. Most local servers accept anything or nothing.",
      render: (setting) => {
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.setValue(plugin.settings.openaiCompatKey).onChange(async (v) => {
            plugin.settings.openaiCompatKey = v.trim();
            await plugin.saveSettings();
          });
        });
      },
    },
    {
      name: "Test endpoint",
      desc: "Checks the endpoint is reachable and lists its models.",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        setting.addButton((btn) =>
          btn.setButtonText("Test endpoint").onClick(async () => {
            await plugin.saveSettings();
            ctx.renderStatus(status, { ok: true, detail: "Testing…" });
            ctx.renderStatus(status, await plugin.router().openaiCompat.test());
          }),
        );
      },
    },
  ];
}
