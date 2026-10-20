import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";

export type SettingsCategory = "chat" | "vault" | "capture" | "connections" | "files";
export interface SettingsSection {
  id: string;
  title: string;
  category: SettingsCategory;
  description: string;
  items: SettingGroupItem[];
}

const PAGES: Record<string, [string, string, SettingsCategory]> = {
  Connection: ["connection", "Provider & model", "chat"],
  Behavior: ["context", "Prompts & context", "chat"],
  "Agent bridge — MCP server (desktop)": ["bridge", "Vault bridge (MCP)", "connections"],
  "External tools — MCP client": ["external-tools", "External tools", "connections"],
  "Cloud (experimental)": ["cloud", "Cloud sessions (experimental)", "connections"],
  Publishing: ["publishing", "Publishing", "connections"],
  "Semantic search (local embeddings)": ["semantic", "Semantic search", "capture"],
  "Local models (Ollama & endpoints)": ["local", "Local models", "chat"],
  "Source capture (typed clips)": ["capture", "Source capture", "capture"],
  "Vault ontology (typed notes & relations)": ["ontology", "Note types & relations", "capture"],
  "Research Desk & discovery": ["research", "Research & discovery", "capture"],
  "Session memory": ["memory", "Session memory", "files"],
  "Files & tags": ["files", "Files & tags", "files"],
  "What this plugin accesses (privacy)": ["privacy", "Privacy & data access", "files"],
  "Desktop-only features": ["desktop", "Desktop-only features", "connections"],
};

export function settingVisible(item: { visible?: boolean | (() => boolean) }): boolean {
  return typeof item.visible === "function" ? item.visible() : item.visible !== false;
}

/** Reuse the original definitions, callbacks and dependency predicates in both views. */
export function settingsSections(definitions: SettingDefinitionItem[]): SettingsSection[] {
  const sections: SettingsSection[] = [];
  const visit = (definition: SettingDefinitionItem): void => {
    if (!settingVisible(definition)) return;
    if (!("type" in definition)) return;
    const name = definition.type === "page" ? definition.name : definition.heading;
    if (definition.type === "page" && name === "Agent (act on your vault)") {
      const items = definition.items ?? [];
      const groups: Array<[string, string, string[]]> = [
        ["permissions", "Note permissions", ["agentModeEnabled", "agentAllowWrites"]],
        ["editing", "Editing & review", ["inlineDiffEnabled", "selectionActionEnabled"]],
        ["agent", "Agent behavior", ["standingOrdersEnabled", "notifyOnTurnComplete", "agentMaxIterations", "agentAutoContinue"]],
      ];
      const assigned = new Set(groups.flatMap(([, , keys]) => keys));
      for (const [id, title, keys] of groups) {
        const selected = items.filter((item): item is SettingGroupItem => "control" in item && item.control !== undefined && keys.includes(item.control.key));
        if (selected.length) sections.push({ id, title, category: "vault", description: "", items: selected.map(permissionLabel) });
      }
      const web = items.filter((item) => !("control" in item && item.control && assigned.has(item.control.key)));
      if (web.length) sections.push({ id: "web", title: "Web tools", category: "vault", description: "", items: web as SettingGroupItem[] });
      return;
    }
    const metadata = name ? PAGES[name] : undefined;
    if (metadata) {
      const [id, title, category] = metadata;
      sections.push({ id, title, category, description: "desc" in definition && typeof definition.desc === "string" ? definition.desc : "", items: (definition.items ?? []) as SettingGroupItem[] });
    } else {
      for (const child of definition.items ?? []) visit(child);
    }
  };
  for (const definition of definitions) visit(definition);
  const intro = definitions.find((item) => "type" in item && item.type === "group" && !item.heading);
  const integrations = intro && "items" in intro ? intro.items?.filter((item) => "name" in item && item.name === "Desktop integrations") : [];
  if (integrations?.some(settingVisible)) sections.push({ id: "integrations", title: "Desktop integrations", category: "connections", description: "Set up desktop assistants for this vault.", items: integrations as SettingGroupItem[] });
  return sections;
}

function permissionLabel(item: SettingGroupItem): SettingGroupItem {
  if (!("control" in item) || !item.control) return item;
  if (item.control.key === "agentModeEnabled") return { ...item, name: "Read and search notes", desc: "Let the chat agent find relevant notes.", aliases: [...item.aliases ?? [], item.name] };
  if (item.control.key === "agentAllowWrites") return { ...item, name: "Create and edit notes", desc: "Every change asks for your confirmation.", aliases: [...item.aliases ?? [], item.name] };
  return item;
}

/** Search labels and metadata only. Saved values (including secrets) are never indexed. */
export function searchSettings(sections: SettingsSection[], query: string): SettingsSection[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return sections.flatMap((section) => {
    const items = section.items.filter((item) => {
      if (!settingVisible(item)) return false;
      const key = "control" in item ? item.control?.key : "";
      const text = [section.title, section.description, item.name, typeof item.desc === "string" ? item.desc : item.desc?.textContent, ...("aliases" in item ? item.aliases ?? [] : []), key].join(" ").toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
    return items.length ? [{ ...section, items }] : [];
  });
}
