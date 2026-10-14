// The Semantic search page of the settings tab: engine, model download, and
// index rebuild controls.

import { Platform, type ButtonComponent, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import type { SemanticController } from "../semantic/controller";
import { BUILTIN_EMBEDDING_MODELS, builtinModelById } from "../semantic/transformers/model";
import type { PluginSettings } from "../types";
import { cachedModelHint, selectEmbedding, showCachedModelHint } from "./actions";
import { renderIndexRebuild, setSemanticActionBusy } from "./semanticRebuild";

export interface SemanticItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "activity" | "router" | "saveSettings" | "settings"> & {
    semantic: () => Pick<SemanticController, "builtinEmbedder" | "builtinModelCached" | "clearBuiltinModel" | "indexer" | "invalidateIndexer" | "rebuildSemanticIndex" | "buildProgress" | "subscribeBuildProgress">;
  };
  /** Re-render the settings page. */
  update(): void;
  /** Offer to rebuild an index built with a different embedding model. */
  offerIndexRebuild(label: string): void;
}

export function semanticItems(ctx: SemanticItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const enabled = (): boolean => plugin.settings.semanticEnabled;
  return [
    { name: "Enable semantic search", desc: "Build a local vector index so the vault is searchable by meaning, not just keywords. Private and on-device. Powers the “Search vault” context and Ask-your-vault.", control: { type: "toggle", key: "semanticEnabled" } },
    {
      name: "Embedding engine",
      desc: "Built-in runs inside Obsidian on every platform (one-time download). Ollama uses a reachable server; mobile needs a LAN or remote address. Endpoint uses the OpenAI-compatible server from Local models.",
      visible: enabled,
      render: (setting) => {
        setting.addDropdown((dd) => {
          dd.addOption("builtin", "Built-in (recommended)");
          dd.addOption("ollama", "Ollama");
          dd.addOption("custom", "OpenAI-compatible endpoint");
          dd.setValue(plugin.settings.embeddingEngine).onChange(async (v) => {
            if (v === plugin.settings.embeddingEngine) return;
            const notes = (await plugin.semantic().indexer()?.stats().catch(() => null))?.notes ?? 0;
            const r = selectEmbedding(plugin.settings, { key: "embeddingEngine", value: v as PluginSettings["embeddingEngine"] }, notes);
            if (!r.changed) return;
            await plugin.saveSettings();
            plugin.semantic().invalidateIndexer();
            ctx.update();
            if (r.rebuildLabel !== null) ctx.offerIndexRebuild(r.rebuildLabel);
          });
        });
      },
    },
    {
      name: "Built-in model",
      desc: "Arctic XS is recommended on mobile for its smaller memory footprint. Larger models use more memory; retrieval quality depends on your notes. Use Rebuild index after switching.",
      visible: () => enabled() && plugin.settings.embeddingEngine === "builtin",
      render: (setting) => {
        setting.addDropdown((dd) => {
          for (const m of BUILTIN_EMBEDDING_MODELS) {
            const recommendation = Platform.isMobile && m.id === BUILTIN_EMBEDDING_MODELS[0]?.id ? " · recommended on mobile" : "";
            dd.addOption(m.id, `${m.hfRepo.split("/")[1]} · ${m.dim}d · ~${m.approxDownloadMB} MB${recommendation}`);
          }
          dd.setValue(builtinModelById(plugin.settings.builtinEmbeddingModel).id).onChange(async (v) => {
            if (v === plugin.settings.builtinEmbeddingModel) return;
            const notes = (await plugin.semantic().indexer()?.stats().catch(() => null))?.notes ?? 0;
            const r = selectEmbedding(plugin.settings, { key: "builtinEmbeddingModel", value: v }, notes);
            if (!r.changed) return;
            await plugin.saveSettings();
            plugin.semantic().invalidateIndexer();
            ctx.update();
            if (r.rebuildLabel !== null) ctx.offerIndexRebuild(r.rebuildLabel);
          });
        });
      },
    },
    {
      name: "Embedding model",
      visible: () => enabled() && plugin.settings.embeddingEngine === "builtin",
      render: (setting) => {
        const model = builtinModelById(plugin.settings.builtinEmbeddingModel);
        const backend = plugin.semantic().builtinEmbedder().backend();
        setting.setDesc(`${model.hfRepo} (~${model.approxDownloadMB} MB from huggingface.co + ~23 MB ONNX runtime from cdn.jsdelivr.net; cached and on-device afterwards). Updated model assets require an explicit download and index rebuild.`);
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status setting-item-description" });
        status.setText(backend ? `Model ready · ${backend === "webgpu" ? "WebGPU" : "WASM"}` : "Model not downloaded yet.");

        let mainBtn: ButtonComponent | null = null;
        let clearBtn: ButtonComponent | null = null;
        let running = false;
        let clearing = false;
        setting.addButton((btn) => {
          // Non-CTA: delete the downloaded model from the local cache. Hidden
          // until we know there is something to clear (loaded or cached).
          clearBtn = btn;
          btn.buttonEl.addClass("cc-semantic-action");
          btn.setButtonText("Clear").onClick(async () => {
            if (clearing || running) return;
            clearing = true;
            setSemanticActionBusy(btn, true, "Clearing…");
            mainBtn?.setDisabled(true);
            try {
              await plugin.semantic().clearBuiltinModel();
              ctx.update(); // status returns to "Model not downloaded yet."
            } catch (e) {
              status.setText(`Clear failed: ${e instanceof Error ? e.message : String(e)}`);
              status.addClass("is-err");
            } finally {
              clearing = false;
              setSemanticActionBusy(btn, false, "Clear");
              mainBtn?.setDisabled(false);
            }
          });
          if (!backend) btn.buttonEl.hide();
        });
        setting.addButton((btn) => {
          mainBtn = btn;
          btn.buttonEl.addClass("cc-semantic-action");
          btn
            .setButtonText(backend ? "Re-check" : `Download (~${model.approxDownloadMB} MB)`)
            .setCta()
            .onClick(async () => {
              if (running || clearing) return;
              running = true;
              setSemanticActionBusy(btn, true, backend ? "Checking…" : "Downloading…");
              clearBtn?.setDisabled(true);
              status.removeClass("is-ok");
              status.removeClass("is-err");
              status.setText(backend ? "Checking built-in model…" : "Downloading built-in model…");
              try {
                await plugin.semantic().builtinEmbedder().download((p) => status.setText(`Downloading… ${p.percent}% (${p.file})`));
                const b = plugin.semantic().builtinEmbedder().backend();
                if (!b) throw new Error("model did not load");
                status.setText(`Model ready · ${b === "webgpu" ? "WebGPU" : "WASM"}`);
                status.addClass("is-ok");
                btn.setButtonText("Re-check");
                clearBtn?.buttonEl.show();
              } catch (e) {
                status.setText(`Download failed: ${e instanceof Error ? e.message : String(e)} — check your connection and retry.`);
                status.addClass("is-err");
                btn.setButtonText("Retry download");
              } finally {
                running = false;
                setSemanticActionBusy(btn, false, btn.buttonEl.textContent ?? "Re-check");
                clearBtn?.setDisabled(false);
              }
            });
        });
        if (!backend) {
          // Distinguish "downloaded earlier, not loaded this session" (offline
          // load) from "never downloaded" (network download needing consent).
          void plugin.semantic().builtinModelCached().then((cached) => {
            if (!showCachedModelHint({ cached, running, backendLoaded: !!plugin.semantic().builtinEmbedder().backend() })) return;
            status.setText(cachedModelHint(Platform.isMobile));
            mainBtn?.setButtonText("Load");
            clearBtn?.buttonEl.show();
          });
        }
      },
    },
    {
      name: "Ollama embedding model",
      desc: "An Ollama embedding model. Pull one first, e.g. `ollama pull nomic-embed-text`.",
      visible: () => enabled() && plugin.settings.embeddingEngine === "ollama",
      render: (setting) => {
        setting.addDropdown((dd) => {
          const cur = plugin.settings.embeddingModel || "nomic-embed-text";
          // Always show the current selection; the running server's models are
          // added asynchronously below.
          dd.addOption(cur, cur);
          dd.setValue(cur).onChange(async (v) => {
            plugin.settings.embeddingModel = v.trim() || "nomic-embed-text";
            await plugin.saveSettings();
          });
          void plugin
            .router()
            .ollama.listModels()
            .then((models) => {
              for (const m of models) if (m !== cur) dd.addOption(m, m);
            })
            .catch(() => {
              /* Ollama not reachable — leave just the current value. */
            });
        });
      },
    },
    {
      name: "Endpoint embedding model",
      desc: "An embedding model the OpenAI-compatible endpoint (configured under Local models) serves, e.g. text-embedding-nomic-embed-text-v1.5.",
      visible: () => enabled() && plugin.settings.embeddingEngine === "custom",
      render: (setting) => {
        setting.addDropdown((dd) => {
          const cur = plugin.settings.openaiCompatEmbeddingModel;
          // Always show the current selection; the endpoint's models are added
          // asynchronously below.
          if (cur) dd.addOption(cur, cur);
          else dd.addOption("", "Not set — pick one once detected");
          dd.setValue(cur).onChange(async (v) => {
            plugin.settings.openaiCompatEmbeddingModel = v.trim();
            await plugin.saveSettings();
            plugin.semantic().invalidateIndexer();
          });
          void plugin
            .router()
            .openaiCompat.listModels()
            .then((models) => {
              for (const m of models) if (m !== cur) dd.addOption(m, m);
            })
            .catch(() => {
              /* Endpoint not reachable — leave just the current value. */
            });
        });
      },
    },
    {
      name: "Index PDF text",
      desc: "Extract text from vault PDFs into the semantic index (page numbers kept, so results cite the page). Rebuilds the index on the next save or manual rebuild.",
      visible: enabled,
      control: { type: "toggle", key: "semanticIndexPdfs" },
    },
    {
      name: "Rebuild index",
      desc: "Embed every note now. Re-embeds only changed notes on save afterward.",
      visible: enabled,
      render: (setting) => renderIndexRebuild(setting, plugin),
    },
  ];
}
