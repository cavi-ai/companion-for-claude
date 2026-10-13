import { clearNotices, getNoticeMessages } from "obsidian";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "./fakes/plugin";

describe("startInlineEdit", () => {
  it("without a note in the editor shows the notice and opens nothing", async () => {
    clearNotices();
    const plugin = buildPlugin();
    await (plugin as unknown as { startInlineEdit(editor: unknown, view: unknown): Promise<void> }).startInlineEdit({}, { file: null });
    expect(getNoticeMessages()).toEqual(["Open a note in the editor to edit with Claude."]);
  });
});
