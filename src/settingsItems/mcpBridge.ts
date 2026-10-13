// The Agent bridge page: server toggle, port, access token, status, and connection snippets.

import type { SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { generateToken, bridgeUrl, claudeCodeCommand, claudeDesktopConfig, maskToken, resolveMcpToken, mcpTokenEnvRef, MCP_TOKEN_ENV } from "../mcp/clientConfig";
import { regenerateMcpToken, setCredential, setMcpEnabled } from "./actions";

export interface McpBridgeItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "mcpRunning" | "saveSettings" | "settings">;
  /** Re-render the settings page. */
  update(): void;
  /** Transient (not persisted): reveal the real MCP token in the snippets. */
  tokenReveal: { shown: boolean };
}

function codeBlock(containerEl: HTMLElement, label: string, code: string, copyText: string = code): void {
  const wrap = containerEl.createDiv({ cls: "cc-snippet" });
  const head = wrap.createDiv({ cls: "cc-snippet-head" });
  head.createSpan({ text: label });
  const copy = head.createEl("button", { cls: "cc-action", text: "Copy" });
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(copyText);
    copy.setText("Copied");
    window.setTimeout(() => copy.setText("Copy"), 1200);
  });
  wrap.createEl("pre", { cls: "cc-snippet-pre" }).createEl("code", { text: code });
}

export function mcpItems(ctx: McpBridgeItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const s = plugin.settings;
  const env = (): Record<string, string | undefined> => (window as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const resolved = (): ReturnType<typeof resolveMcpToken> => resolveMcpToken(env(), s.mcpToken);
  return [
    {
      name: "Enable MCP server",
      desc: "Runs a local server on the port below. Turn off to stop sharing your vault.",
      render: (setting) => {
        setting.addToggle((t) =>
          t.setValue(s.mcpEnabled).onChange(async (v) => {
            setMcpEnabled(s, v, () => Boolean(resolved().token), generateToken);
            await plugin.saveSettings();
            ctx.update();
          }),
        );
      },
    },
    { name: "Port", desc: "Local port for the MCP server (loopback only).", control: { type: "number", key: "mcpPort", min: 1, max: 65535, step: 1 } },
    {
      name: "Access token",
      aliases: ["bearer", MCP_TOKEN_ENV],
      render: (setting) => {
        const r = resolved();
        if (r.source === "env") {
          setting.setDesc(`✓ Sourced from the $${MCP_TOKEN_ENV} environment variable — not stored in this vault. Unset it to use a stored token instead.`);
          return;
        }
        setting.setDesc(`Required by clients as a bearer token. Keep it secret. Tip: set $${MCP_TOKEN_ENV} to source it from the environment instead of this vault's data.`);
        setting
          .addText((text) => {
            text.inputEl.type = "password"; // bearer token — don't render in plaintext
            text.inputEl.setCssStyles({ width: "min(260px, 100%)" });
            text.setValue(s.mcpToken).onChange(async (v) => {
              setCredential(s, "mcpToken", v);
              await plugin.saveSettings();
            });
          })
          .addButton((btn) =>
            btn.setButtonText("Regenerate").onClick(async () => {
              regenerateMcpToken(s, generateToken);
              await plugin.saveSettings();
              ctx.update();
            }),
          );
      },
    },
    { name: "Allow writes", desc: "Let connected clients create and append notes (read & search are always allowed).", control: { type: "toggle", key: "mcpAllowWrites" } },
    { name: "Agents can record memory", desc: "Add facts to What Claude Knows: outside agents when Allow writes is on, chat when Allow write tools is on.", control: { type: "toggle", key: "memoryRecordEnabled" } },
    { name: "Write folder", desc: "Default folder for notes created via MCP.", control: { type: "text", key: "mcpWriteFolder", placeholder: "Claude/Inbox" } },
    {
      name: "Bridge status",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        const running = plugin.mcpRunning();
        status.toggleClass("is-ok", running && s.mcpEnabled);
        status.toggleClass("is-err", s.mcpEnabled && !running);
        if (!s.mcpEnabled) status.setText("Server disabled.");
        else status.setText(running ? `✓ Running at ${bridgeUrl(s.mcpPort)}` : "✗ Not running — check the port isn't in use.");
      },
    },
    {
      name: "Show token in snippets",
      desc: "Off by default so the snippets are safe to screen-share. Copy always copies the real, working command.",
      visible: () => s.mcpEnabled && resolved().source === "stored",
      render: (setting) => {
        setting.addToggle((t) =>
          t.setValue(ctx.tokenReveal.shown).onChange((v) => {
            ctx.tokenReveal.shown = v;
            ctx.update();
          }),
        );
      },
    },
    {
      name: "Connection snippets",
      aliases: ["claude desktop", "claude code", "config"],
      visible: () => s.mcpEnabled,
      render: (setting) => {
        const r = resolved();
        if (r.source === "none") {
          setting.setDesc(`Set an access token (or $${MCP_TOKEN_ENV}) to get connection snippets.`);
          return;
        }
        // Display is share-safe (env ref or masked); Copy is the real command.
        const real = { port: s.mcpPort, token: r.token };
        const display = r.source === "env"
          ? { port: s.mcpPort, token: mcpTokenEnvRef() } // expands in the user's shell
          : { port: s.mcpPort, token: ctx.tokenReveal.shown ? r.token : maskToken(r.token) };
        const copyInfo = r.source === "env" ? display : real;
        codeBlock(setting.settingEl, "Advanced Claude Code MCP connection (ordinary use is CLI-first):", claudeCodeCommand(display), claudeCodeCommand(copyInfo));
        codeBlock(setting.settingEl, "Claude Desktop (add to claude_desktop_config.json):", claudeDesktopConfig(display), claudeDesktopConfig(copyInfo));
      },
    },
  ];
}
