import { describe, expect, it } from "vitest";
import type { SettingDefinitionItem } from "obsidian";
import { searchSettings, settingsSections } from "../src/settingsItems/navigation";

const definitions: SettingDefinitionItem[] = [
  { type: "group", heading: "Connection", items: [
    { name: "Chat backend", control: { type: "dropdown", key: "chatBackend", options: { claude: "Claude" } } },
  ] },
  { type: "group", heading: "Agent", items: [
    { type: "page", name: "Agent (act on your vault)", items: [
      { name: "Let Claude use vault tools", control: { type: "toggle", key: "agentModeEnabled" } },
      { name: "Allow write tools", control: { type: "toggle", key: "agentAllowWrites" } },
      { name: "Web search tool", aliases: ["internet"], control: { type: "toggle", key: "webSearchEnabled" } },
    ] },
    { type: "page", name: "Agent bridge — MCP server (desktop)", visible: () => false, items: [
      { name: "Enable MCP server", control: { type: "toggle", key: "mcpEnabled" } },
    ] },
    { type: "page", name: "External tools — MCP client", items: [
      { name: "Add server", render: () => {} },
    ] },
  ] },
];

describe("settings navigation catalog", () => {
  it("separates chat permissions from external connections without losing controls", () => {
    const sections = settingsSections(definitions);
    const permissions = sections.find((section) => section.id === "permissions");
    expect(permissions?.category).toBe("vault");
    expect(permissions?.items.map((item) => item.name)).toEqual(["Read and search notes", "Create and edit notes"]);
    expect(sections.find((section) => section.id === "external-tools")?.category).toBe("connections");
    expect(sections.flatMap((section) => section.items).filter((item) => "control" in item)).toHaveLength(4);
  });

  it("preserves platform visibility when flattening page definitions", () => {
    expect(settingsSections(definitions).some((section) => section.id === "bridge")).toBe(false);
  });

  it("finds technical settings by aliases and keys, even when their section is collapsed", () => {
    const sections = settingsSections(definitions);
    expect(searchSettings(sections, "internet").map((section) => section.id)).toEqual(["web"]);
    expect(searchSettings(sections, "agentAllowWrites").flatMap((section) => section.items).map((item) => item.name)).toEqual(["Create and edit notes"]);
  });

  it("searches all words and excludes controls whose dependency is disabled", () => {
    const sections = settingsSections([{ type: "group", heading: "Connection", items: [
      { name: "API base URL", desc: "Use a gateway proxy", control: { type: "text", key: "baseUrl" } },
      { name: "OAuth token", visible: () => false, control: { type: "text", key: "oauthToken" } },
    ] }]);
    expect(searchSettings(sections, "gateway url")[0]?.items[0]?.name).toBe("API base URL");
    expect(searchSettings(sections, "OAuth")).toEqual([]);
    expect(searchSettings(sections, "no-such-setting")).toEqual([]);
  });
});
