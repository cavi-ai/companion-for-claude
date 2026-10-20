// The settings tab's opening group: callouts, the advanced-settings reveal,
// and the desktop-integrations entry point, above the first heading.

import { Platform, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { chatBackendForRuntime } from "../providers/runtimeBackend";
import { needsCredentialSetup } from "../providers/setupState";
import { claudeBackend } from "../cli/backends/claude";
import { codexBackend } from "../cli/backends/codex";
import { opencodeBackend } from "../cli/backends/opencode";
import type { CliBackend } from "../cli/backends/types";
import { capitalize } from "./codecs";

export interface IntroItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "desktopIntegrations" | "router" | "secrets" | "settings">;
  secretStorageWorking(): boolean;
  storageBlurb(): string;
}

export function introItems(ctx: IntroItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  return [
    {
      name: "Credentials are stored in this vault",
      // Credentials fall back to this vault's data.json two ways: no secret-store
      // API, or a backend that refused the write. Both ride vault sync.
      visible: () => !ctx.secretStorageWorking(),
      render: (setting) => {
        const unsupported = !plugin.secrets().available();
        const warn = setting.settingEl.createDiv({ cls: "cc-connect-callout" });
        const p = warn.createEl("p");
        p.appendText(
          unsupported
            ? "This version of Obsidian has no encrypted secret storage, so keys and tokens are written to this vault’s "
              + "data.json — if the vault syncs to iCloud, Dropbox, or git, they sync with it. "
              + "Update Obsidian and Companion will move them into your device’s keychain automatically."
            : "Your device’s secret storage did not accept the write, so keys and tokens remain in this vault’s "
              + "data.json — if the vault syncs to iCloud, Dropbox, or git, they sync with it. "
              + "Companion keeps them there rather than losing them, and moves them across as soon as the store works.",
        );
        if (Platform.isLinux) {
          p.appendText(" On Linux that needs kwallet, kwallet5, kwallet6, or gnome-libsecret installed.");
        }
      },
    },
    {
      name: "Step 1 — connect to Claude",
      // The one mandatory step, called out while it's missing.
      visible: () => {
        const router = plugin.router();
        return needsCredentialSetup({
          backend: router.chatBackend,
          hasAnthropicCredential: router.anthropic.hasCredentials(),
          hasClaudeCli: router.claudeCli.hasCredentials(),
          hasCodexCli: router.codexCli.hasCredentials(),
          hasOpencodeCli: router.opencodeCli.hasCredentials(),
        });
      },
      render: (setting) => {
        const callout = setting.settingEl.createDiv({ cls: "cc-connect-callout" });
        const p = callout.createEl("p");
        const backend = chatBackendForRuntime(plugin.settings.chatBackend, Platform.isMobile);
        const cliBackends: Record<string, CliBackend> = { "claude-cli": claudeBackend, "codex-cli": codexBackend, "opencode-cli": opencodeBackend };
        const cli = cliBackends[backend];
        if (cli) {
          p.appendText(`${cli.label} is not signed in on this computer. ${capitalize(cli.signInHint)} in a terminal, or add an Anthropic API key below. `);
        } else {
          p.appendText("Add an Anthropic API key below to start chatting. Create one at ");
          p.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
        }
        p.appendText(` — ${ctx.storageBlurb().replace(/^S/, "s")}`);
      },
    },
    {
      name: "Desktop integrations",
      visible: () => !Platform.isMobile,
      desc: "Install the CAVI marketplace plugin and merge the Claude Desktop config.",
      aliases: ["marketplace", "claude desktop", "obsidian-agent"],
      render: (setting) => {
        setting.addButton((btn) => btn.setButtonText("Set up").onClick(() => plugin.desktopIntegrations().open()));
      },
    },
  ];
}
