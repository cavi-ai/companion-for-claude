// The Publishing page: Gist token, token test, and the published-items list.

import type { SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { setCredential } from "./actions";

export interface PublishItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "publishing" | "saveSettings" | "settings">;
  /** Re-render the settings page. */
  update(): void;
  storageBlurb(): string;
}

export function publishItems(ctx: PublishItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const s = plugin.settings;
  return [
    {
      name: "GitHub Gist token",
      render: (setting) => {
        setting.setDesc(`Fine-grained token with account permission Gists: read and write. ${ctx.storageBlurb()}`);
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.setCssStyles({ width: "min(320px, 100%)" });
          text
            .setPlaceholder("github_pat_… / ghp_…")
            .setValue(s.publishGithubToken)
            .onChange(async (v) => {
              setCredential(s, "publishGithubToken", v);
              await plugin.saveSettings();
            });
        });
      },
    },
    {
      name: "Test Gist token",
      desc: "Ask GitHub whether the token can list gists.",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        setting.addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setDisabled(true);
            status.toggleClass("is-ok", false);
            status.toggleClass("is-err", false);
            status.setText("Testing…");
            const result = await plugin.publishing().testPublishToken();
            status.toggleClass("is-ok", result.ok);
            status.toggleClass("is-err", !result.ok);
            status.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
            button.setDisabled(false);
          }),
        );
      },
    },
    {
      name: "Published items",
      render: (setting) => {
        const list = setting.settingEl.createDiv({ cls: "cc-publish-list" });
        const items = plugin.publishing().publishedItems();
        if (items.length === 0) list.createDiv({ cls: "cc-publish-empty", text: "Nothing published yet." });
        for (const item of items) {
          const row = list.createDiv({ cls: "cc-publish-row" });
          row.createEl("a", { text: item.title, attr: { href: item.url } });
          row.createSpan({ cls: "cc-publish-kind", text: item.kind });
          const remove = row.createEl("button", { text: "Unpublish" });
          remove.addEventListener("click", () => {
            remove.disabled = true;
            void plugin.publishing().unpublishItem(item.key).then(() => ctx.update());
          });
        }
      },
    },
  ];
}
