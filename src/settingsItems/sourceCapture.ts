// The Source capture page: inbox watching, enrichment, and Web Clipper template export.

import type { SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";

export interface SourceCaptureItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "clipperSetup" | "settings">;
}

export function sourceCaptureItems(ctx: SourceCaptureItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  return [
    { name: "Enable source capture", desc: "Master switch for watching the inbox and the “Enrich note as source” command.", control: { type: "toggle", key: "sourceCaptureEnabled" } },
    { name: "Auto-enrich on create", desc: "Type files automatically as they appear in the inbox (otherwise use the command).", control: { type: "toggle", key: "sourceEnrichOnCreate" } },
    { name: "Inbox folder", desc: "Folder the Web Clipper writes to and Companion watches.", control: { type: "text", key: "sourceInboxFolder", placeholder: "Clippings" } },
    { name: "Organized folder", desc: "Where “Organize clippings” moves reviewed clips — one subfolder per inferred topic/project.", control: { type: "text", key: "clipOrganizedFolder", placeholder: "Library" } },
    { name: "Base tags", desc: "Comma-separated tags added to every enriched source note.", control: { type: "text", key: "sourceBaseTags" } },
    {
      name: "Web Clipper templates",
      desc: "Write clipper templates matching these schemas into the vault. Import them in the Web Clipper extension and clips arrive already typed — enrichment then only fills what the page couldn't say.",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status setting-item-description" });
        if (plugin.settings.clipperTemplateFingerprint !== "") {
          const stale = plugin.clipperSetup().templatesStale();
          status.setText(stale ? "✗ Templates out of date — schemas or inbox changed since export." : "✓ Templates current with your schemas.");
          status.toggleClass("is-err", stale);
          status.toggleClass("is-ok", !stale);
        }
        setting.addButton((b) =>
          b.setButtonText("Export templates").onClick(async () => {
            await plugin.clipperSetup().exportTemplates();
            status.setText("✓ Templates current with your schemas.");
            status.toggleClass("is-err", false);
            status.toggleClass("is-ok", true);
          }),
        );
      },
    },
  ];
}
