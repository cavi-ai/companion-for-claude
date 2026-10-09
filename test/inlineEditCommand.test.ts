import { App, clearNotices, getNoticeMessages } from "obsidian";
import { describe, expect, it } from "vitest";
import ClaudeCompanionPlugin from "../src/main";

describe("startInlineEdit", () => {
  it("without a note in the editor shows the notice and opens nothing", async () => {
    clearNotices();
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin as unknown as Record<string, unknown>, { app: new App() });
    await (plugin as unknown as { startInlineEdit(editor: unknown, view: unknown): Promise<void> }).startInlineEdit({}, { file: null });
    expect(getNoticeMessages()).toEqual(["Open a note in the editor to edit with Claude."]);
  });
});
