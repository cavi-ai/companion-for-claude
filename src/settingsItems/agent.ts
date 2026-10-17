// The Agent page: vault tools in chat, write gating, orders, review, and the web tools.

import type { SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { setCredential } from "./actions";

export interface AgentItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "saveSettings" | "settings">;
  storageBlurb(): string;
}

export function agentItems(ctx: AgentItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  return [
    { name: "Let Claude use vault tools", desc: "Claude can search and read your notes on its own while answering (read-only). Turn off for plain chat with pre-attached context.", control: { type: "toggle", key: "agentModeEnabled" } },
    { name: "Allow write tools", desc: "Also let Claude create, edit, and move notes from chat. Every write asks for your confirmation first.", control: { type: "toggle", key: "agentAllowWrites" } },
    { name: "Standing orders", desc: "Run prompt templates that have a schedule or on_note trigger while Obsidian is open.", control: { type: "toggle", key: "standingOrdersEnabled" } },
    { name: "Notify when a turn finishes in the background", desc: "Desktop: reply button. Mobile: notice.", control: { type: "toggle", key: "notifyOnTurnComplete" } },
    { name: "Review edits in the editor", desc: "When the note is open, show proposed changes inline with word-level highlights and per-change Accept/Reject instead of a dialog.", control: { type: "toggle", key: "inlineDiffEnabled" } },
    { name: "Rewrite button on selection", desc: "Show a small “Rewrite with Claude” action above selected text. Desktop only.", control: { type: "toggle", key: "selectionActionEnabled" } },
    { name: "Max tool iterations per turn", desc: "How many search/read/write rounds Claude may take before it must answer. When the cap stops a turn, a Continue button resumes it.", control: { type: "slider", key: "agentMaxIterations", min: 1, max: 50, step: 1 } },
    { name: "Auto-continue capped turns", desc: "When a turn hits the iteration cap, keep going automatically (up to 4 chained continuations) instead of waiting for you to press Continue.", control: { type: "toggle", key: "agentAutoContinue" } },
    { name: "Web search tool", desc: "Let Claude search the public web from chat (explicit searches only — nothing fires in the background).", control: { type: "toggle", key: "webSearchEnabled" } },
    {
      name: "Search engine",
      desc: "DuckDuckGo needs no key; Brave gives higher-quality results with an API key.",
      visible: () => plugin.settings.webSearchEnabled,
      control: { type: "dropdown", key: "webSearchEngine", options: { duckduckgo: "DuckDuckGo (no key)", brave: "Brave Search (API key)" } },
    },
    {
      name: "Brave Search API key",
      visible: () => plugin.settings.webSearchEnabled && plugin.settings.webSearchEngine === "brave",
      render: (setting) => {
        setting.setDesc(`Subscription token from brave.com/search/api. ${ctx.storageBlurb()}`);
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.setValue(plugin.settings.braveSearchApiKey).onChange(async (v) => {
            setCredential(plugin.settings, "braveSearchApiKey", v);
            await plugin.saveSettings();
          });
        });
      },
    },
    { name: "Web fetch tool", desc: "Let Claude read a public web page as clean markdown — after a search, or a URL you give it.", control: { type: "toggle", key: "webFetchEnabled" } },
  ];
}
