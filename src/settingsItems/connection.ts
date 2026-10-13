// The Connection group: authentication, credentials, model, chat backend, the
// on-device model download, and the CLI backends' status rows.

import { Notice, Platform, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { chatBackendOptions } from "../providers/runtimeBackend";
import { DEVICE_MODELS, clearDeviceModel, deviceModelCached } from "../device/models";
import { CLAUDE_MODELS } from "../claude/models";
import type { ProviderStatus } from "../providers/types";
import { readAnthropicEnv, hasAnthropicEnvCredential } from "../providers/env";
import { claudeBackend } from "../cli/backends/claude";
import { codexBackend } from "../cli/backends/codex";
import { opencodeBackend } from "../cli/backends/opencode";
import type { CliBackend } from "../cli/backends/types";
import type { CliProvider } from "../providers/cliProvider";
import { canDeleteDeviceModel, setCredential } from "./actions";
import { cliModelItem } from "./cliModels";

export interface ConnectionItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "deviceChat" | "onboarding" | "refreshViews" | "router" | "saveSettings" | "settings">;
  storageBlurb(): string;
  renderStatus(el: HTMLElement, status: ProviderStatus): void;
}

/** Status row + "Check <label>" button for one CLI backend, shared by Claude Code, Codex, and OpenCode. */
function cliStatusItems(ctx: ConnectionItemsContext, backend: CliBackend, cliOf: (router: ReturnType<ClaudeCompanionPlugin["router"]>) => CliProvider): SettingGroupItem[] {
  const { plugin } = ctx;
  return [
    {
      name: backend.label,
      desc: `Status of the ${backend.binary} command this backend runs. Companion never sees your credentials; ${backend.label} holds them.`,
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        const cli = cliOf(plugin.router());
        const probe = cli.probe();
        if (probe) ctx.renderStatus(status, { ok: probe.loggedIn, detail: probe.loggedIn ? `${backend.label} ${probe.version} · signed in via ${probe.method} · ${probe.executable}` : `Not signed in — ${backend.signInHint}.` });
        setting.addButton((btn) =>
          btn
            .setButtonText(`Check ${backend.label}`)
            .onClick(async () => {
              ctx.renderStatus(status, { ok: true, detail: "Checking…" });
              const result = await cliOf(plugin.router()).test();
              ctx.renderStatus(status, result);
              plugin.refreshViews();
              if (result.ok) await plugin.onboarding().runFirstRunPrompts();
            }),
        );
      },
    },
  ];
}

function deviceModelDownloadItem(ctx: ConnectionItemsContext): SettingGroupItem {
  const { plugin } = ctx;
  return {
    name: "On-device model download",
    desc: "One explicit download from Hugging Face and the ONNX runtime CDN, cached on this device. Missing files require another explicit download. On-device chat text stays in Obsidian; utility task routing is separate. Loading pauses mobile embeddings to reduce memory use. No model loads when Obsidian starts.",
    visible: () => plugin.settings.chatBackend === "device",
    render: (setting) => {
      const status = setting.descEl.createDiv();
      const storage = typeof caches === "undefined" ? undefined : caches;
      const id = plugin.settings.deviceChatModel;
      void deviceModelCached(id, storage).then((ready) => status.setText(ready ? "Downloaded on this device." : "Model not downloaded on this device."));
      let abort: AbortController | undefined;
      setting.addButton((button) => button.setButtonText("Download model").setCta().onClick(async () => {
        if (abort) return;
        abort = new AbortController();
        button.setDisabled(true);
        status.setText("Checking GPU support inside Obsidian…");
        try {
          const support = await plugin.router().device.test();
          if (abort.signal.aborted) return;
          if (!support.ok) throw new Error(support.detail);
          status.setText("Downloading and preparing model…");
          await plugin.deviceChat().download(id, (percent) => status.setText(`Downloading model · ${percent}%`), abort.signal);
          status.setText("Downloaded. Open Companion chat to use this model.");
        } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
        finally { abort = undefined; button.setDisabled(false); }
      }));
      setting.addButton((button) => button.setButtonText("Stop").onClick(() => { abort?.abort(); plugin.deviceChat().cancel(); status.setText("On-device request stopped."); }));
      setting.addButton((button) => button.setButtonText("Delete model").onClick(async () => {
        if (!canDeleteDeviceModel({ chatBusy: plugin.deviceChat().busy(), downloading: abort !== undefined })) { new Notice("Stop the on-device request before deleting its model."); return; }
        try { await clearDeviceModel(id, storage); status.setText("Model removed from this device."); }
        catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
      }));
    },
  };
}

export function connectionItems(ctx: ConnectionItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const s = plugin.settings;
  return [
    {
      name: "Authentication",
      desc: "How Companion for Claude authenticates to Anthropic. API key is the standard, store-safe option.",
      control: {
        type: "dropdown",
        key: "authMode",
        options: {
          apiKey: "API key (recommended)",
          oauthToken: "Long-term OAuth token (subscription)",
          environment: "Import from environment",
        },
      },
    },
    {
      name: "Anthropic API key",
      aliases: ["credential", "anthropic", "sk-ant"],
      visible: () => plugin.settings.authMode === "apiKey",
      render: (setting) => {
        setting.setDesc(
          createFragment((frag) => {
            frag.appendText("Bring your own key from ");
            frag.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
            frag.appendText(`. ${ctx.storageBlurb()}`);
          }),
        );
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.setCssStyles({ width: "320px" });
          text
            .setPlaceholder("sk-ant-api…")
            .setValue(s.apiKey)
            .onChange(async (v) => {
              setCredential(s, "apiKey", v);
              await plugin.saveSettings();
            });
        });
      },
    },
    {
      name: "OAuth token",
      aliases: ["subscription", "setup-token", "sk-ant-oat"],
      visible: () => plugin.settings.authMode === "oauthToken",
      render: (setting) => {
        setting.setDesc(
          "Paste a long-term token from `claude setup-token` (starts with sk-ant-oat). Requests authenticate as your Claude subscription, "
            + `so usage draws on your plan's limits rather than pay-as-you-go API credit. ${ctx.storageBlurb()} Sent as a bearer token.`,
        );
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.setCssStyles({ width: "320px" });
          text
            .setPlaceholder("sk-ant-oat…")
            .setValue(s.oauthToken)
            .onChange(async (v) => {
              setCredential(s, "oauthToken", v);
              await plugin.saveSettings();
            });
        });
      },
    },
    {
      name: "Environment credential",
      aliases: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
      visible: () => plugin.settings.authMode === "environment",
      render: (setting) => {
        const env = readAnthropicEnv();
        const found = hasAnthropicEnvCredential(env);
        const detail = found
          ? `Using ${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"}` + (env.ANTHROPIC_BASE_URL ? " + ANTHROPIC_BASE_URL" : "") + " from the environment."
          : "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found in this process's environment. Note: apps launched from the macOS Dock often don't inherit shell exports — launch Obsidian from a terminal, or use one of the other modes.";
        const box = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        box.toggleClass("is-ok", found);
        box.toggleClass("is-err", !found);
        box.setText((found ? "✓ " : "✗ ") + detail);
      },
    },
    {
      name: "API base URL",
      desc: "Optional. Point at a gateway/proxy instead of api.anthropic.com. Leave blank for the default.",
      control: { type: "text", key: "baseUrl", placeholder: "https://api.anthropic.com" },
    },
    {
      name: "Save & test connection",
      desc: "Saves settings and sends a tiny request to verify your credential.",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        setting.addButton((btn) =>
          btn
            .setButtonText("Save & test")
            .setCta()
            .onClick(async () => {
              await plugin.saveSettings();
              ctx.renderStatus(status, { ok: true, detail: "Testing…" });
              const result = await plugin.router().anthropic.test();
              ctx.renderStatus(status, result);
              // Prompts held back while there was no credential can run now.
              if (result.ok) await plugin.onboarding().runFirstRunPrompts();
            }),
        );
      },
    },
    {
      name: "Model",
      desc: "Pick a default model. A custom id below overrides this.",
      control: {
        type: "dropdown",
        key: "model",
        options: Object.fromEntries(CLAUDE_MODELS.map((m) => [m.id, m.label])),
      },
    },
    {
      name: "Custom model id",
      desc: "Optional. Overrides the dropdown — useful for new or dated model snapshots.",
      control: { type: "text", key: "customModel", placeholder: "e.g. claude-sonnet-4-6-20250930" },
    },
    {
      name: "Chat backend",
      desc: "On-device GPU runs text chat inside Obsidian with a downloaded model. It requires WebGPU and float16 support in this app. Auto starts with Claude and can fall back to a reachable endpoint. CLI backends run on desktop.",
      control: {
        type: "dropdown",
        key: "chatBackend",
        options: chatBackendOptions(Platform.isMobile),
      },
    },
    {
      name: "On-device model",
      desc: "SmolLM2 is the smaller default; Qwen3 is a larger alternative for broader chat tasks. Download sizes exclude runtime files and are smaller than peak memory use. Text only; agent tools are unavailable. Context is limited to 2048 input tokens and replies to 256 tokens.",
      visible: () => plugin.settings.chatBackend === "device",
      control: { type: "dropdown", key: "deviceChatModel", options: Object.fromEntries(DEVICE_MODELS.map((m) => [m.id, m.label])) },
    },
    deviceModelDownloadItem(ctx),
    ...(Platform.isMobile ? [] : cliStatusItems(ctx, claudeBackend, (r) => r.claudeCli)),
    ...(Platform.isMobile ? [] : cliStatusItems(ctx, codexBackend, (r) => r.codexCli)),
    cliModelItem(ctx, codexBackend, "codexModel"),
    ...(Platform.isMobile ? [] : cliStatusItems(ctx, opencodeBackend, (r) => r.opencodeCli)),
    cliModelItem(ctx, opencodeBackend, "opencodeModel"),
    {
      name: "Max response tokens",
      desc: "Upper bound on a single reply (cap 64000). Higher values leave less context-window room.",
      control: { type: "number", key: "maxTokens", min: 1, max: 64000, step: 1 },
    },
  ];
}
