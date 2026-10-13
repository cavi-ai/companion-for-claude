// The Research Desk & discovery page: research model, scholarly discovery, Zotero, and the cache.

import { Notice, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { researchModelOptions } from "../research/researchModel";
import { setCredential } from "./actions";

export interface DiscoveryItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "research" | "router" | "saveSettings" | "settings">;
}

function researchModelChoices(plugin: DiscoveryItemsContext["plugin"]): Record<string, string> {
  const router = plugin.router();
  const chat = router.chatProvider();
  return researchModelOptions({ providerLabel: router.providerLabel(chat.provider), modelId: chat.model }, { modelId: plugin.settings.ollamaModel });
}

export function discoveryItems(ctx: DiscoveryItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  return [
    {
      name: "Research model",
      desc: "Runs only when you click a research action: drafting project questions and claim wording, proposing evidence passages, interpreting evidence, drafting and revising sections, the Intelligence briefing, and reranking Discover results.",
      control: { type: "dropdown", key: "researchModel", options: researchModelChoices(plugin) },
    },
    { name: "Enable scholarly discovery", desc: "Show explicit search, citation expansion, and reranking actions in research projects.", control: { type: "toggle", key: "discoveryEnabled" } },
    { name: "OpenAlex contact email", desc: "Optional. Included as a trimmed mailto parameter in OpenAlex requests.", control: { type: "text", key: "openAlexContactEmail" } },
    { name: "Zotero user id", desc: "Optional. Numeric user id from zotero.org/settings/keys — lets research_source_import resolve a zotero_key into full metadata. Requests fire only on an explicit import.", control: { type: "text", key: "zoteroUserId" } },
    {
      name: "Zotero API key",
      desc: "Optional. Required for private libraries; a public library resolves without one.",
      render: (setting) => {
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.setValue(plugin.settings.zoteroApiKey).onChange(async (value) => {
            setCredential(plugin.settings, "zoteroApiKey", value);
            await plugin.saveSettings();
          });
        });
      },
    },
    {
      name: "Clear discovery cache",
      desc: "Deletes derived discovery state only. It does not write to or delete vault notes.",
      render: (setting) => {
        setting.addButton((button) =>
          button.setButtonText("Clear cache").onClick(() => {
            plugin.research().clearDiscoveryCache();
            new Notice("Discovery cache cleared.");
          }),
        );
      },
    },
  ];
}
