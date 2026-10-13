// The External tools page: one block per configured MCP server plus Add.

import { Setting, type SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { addMcpServer, editMcpServer, removeMcpServer } from "./actions";
import type { McpServerConfig } from "../types";

export interface McpClientItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "externalMcp" | "saveSettings" | "settings">;
  /** Re-render the settings page. */
  update(): void;
}

export function mcpClientItems(ctx: McpClientItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const s = plugin.settings;
  const items: SettingGroupItem[] = [];
  s.mcpClientServers.forEach((server, index) => {
    items.push({
      name: server.name.trim() || `Server ${index + 1}`,
      desc: `${server.transport === "http" ? "HTTP" : "stdio (desktop)"}${server.enabled ? "" : " · disabled"}`,
      aliases: ["mcp", "external tools"],
      render: (setting) => {
        const box = setting.settingEl.createDiv({ cls: "cc-mcp-server" });
        setting
          .addToggle((t) =>
            t.setValue(server.enabled).onChange(async (v) => {
              editMcpServer(server, { field: "enabled", value: v });
              await plugin.saveSettings();
              ctx.update();
            }),
          )
          .addButton((b) =>
            b.setButtonText("Remove").onClick(async () => {
              removeMcpServer(s, index);
              await plugin.saveSettings();
              ctx.update();
            }),
          );

        new Setting(box).setName("Name").addText((text) =>
          text.setValue(server.name).onChange(async (v) => {
            editMcpServer(server, { field: "name", value: v });
            await plugin.saveSettings();
          }),
        );

        new Setting(box).setName("Transport").addDropdown((dd) => {
          dd.addOption("http", "HTTP (streamable)");
          dd.addOption("stdio", "stdio command (desktop)");
          dd.setValue(server.transport).onChange(async (v) => {
            editMcpServer(server, { field: "transport", value: v as McpServerConfig["transport"] });
            await plugin.saveSettings();
            ctx.update();
          });
        });

        if (server.transport === "http") {
          new Setting(box).setName("Server URL").addText((text) => {
            text.inputEl.setCssStyles({ width: "320px" });
            text.setPlaceholder("https://example.test/mcp").setValue(server.url).onChange(async (v) => {
              editMcpServer(server, { field: "url", value: v });
              await plugin.saveSettings();
            });
          });
        } else {
          new Setting(box).setName("Command").addText((text) => {
            text.inputEl.setCssStyles({ width: "240px" });
            text.setPlaceholder("npx").setValue(server.command).onChange(async (v) => {
              editMcpServer(server, { field: "command", value: v });
              await plugin.saveSettings();
            });
          });
          new Setting(box).setName("Arguments").addText((text) => {
            text.inputEl.setCssStyles({ width: "320px" });
            text.setPlaceholder("-y @modelcontextprotocol/server-filesystem /path").setValue(server.args).onChange(async (v) => {
              editMcpServer(server, { field: "args", value: v });
              await plugin.saveSettings();
            });
          });
        }

        const status = box.createDiv({ cls: "cc-conn-status" });
        const error = plugin.externalMcp().errorFor(server.name.trim());
        if (error) {
          status.addClass("is-err");
          status.setText(`✗ ${error}`);
        }
        new Setting(box)
          .setName("Test connection")
          .setDesc("Connect now and count the exposed tools.")
          .addButton((button) =>
            button.setButtonText("Test").onClick(async () => {
              button.setDisabled(true);
              status.removeClass("is-ok");
              status.removeClass("is-err");
              status.setText("Connecting…");
              const result = await plugin.externalMcp().test(server);
              status.addClass(result.ok ? "is-ok" : "is-err");
              status.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
              button.setDisabled(false);
            }),
          );
      },
    });
  });
  items.push({
    name: "Add server",
    desc: "Register another MCP server for the in-chat agent.",
    render: (setting) => {
      setting.addButton((b) =>
        b.setButtonText("Add MCP server").setCta().onClick(async () => {
          addMcpServer(s);
          await plugin.saveSettings();
          ctx.update();
        }),
      );
    },
  });
  return items;
}
