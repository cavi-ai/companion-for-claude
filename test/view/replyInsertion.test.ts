import { App, clearNotices, getNoticeMessages, type Editor } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { formatReplyInsertion, insertReplyIntoNote } from "../../src/view/chat/replyInsertion";

describe("structured reply insertion", () => {
  it("keeps an appended heading separate from the existing paragraph", () => {
    expect(formatReplyInsertion("## Findings\n\n- Review evidence.", "Keep this guidance.", "")).toBe("\n\n## Findings\n\n- Review evidence.");
  });
  it("protects the following heading when inserting at the start of a note", () => {
    expect(formatReplyInsertion("## Findings\n\nResults.", "", "# Existing note")).toBe("## Findings\n\nResults.\n\n");
  });
  it("separates both sides when replacing an inline placeholder with a block", () => {
    expect(formatReplyInsertion("- First\n- Second", "Introduction. ", " More guidance.")).toBe("\n\n- First\n- Second\n\n");
  });
  it("reuses blank lines already present in the note or reply", () => {
    expect(formatReplyInsertion("## Findings\n\nResults.", "Before.\n\n", "\n\nAfter.")).toBe("## Findings\n\nResults.");
    expect(formatReplyInsertion("\n## Findings\n", "Before.\n", "\nAfter.")).toBe("\n## Findings\n");
    expect(formatReplyInsertion("## Findings\n\nResults.", "Before.\n", "\nAfter.")).toBe("\n## Findings\n\nResults.\n");
  });
  it("keeps an empty destination or whole-note replacement exact", () => {
    expect(formatReplyInsertion("## Findings\n\nResults.", "", "")).toBe("## Findings\n\nResults.");
  });
  it("preserves single-line plain text insertion and an empty reply", () => {
    expect(formatReplyInsertion("reviewed", "The ", " evidence.")).toBe("reviewed");
    expect(formatReplyInsertion("", "Before", "After")).toBe("");
  });
  it.each(["## Findings", "- Review evidence", "1. Review evidence", "> Quoted evidence", "```md", "| Claim | Evidence |"])("separates the single-line Markdown block %j", text => {
    expect(formatReplyInsertion(text, "Before.", "After.")).toBe(`\n\n${text}\n\n`);
  });
});

describe("inserting from Reading view", () => {
  beforeEach(clearNotices);
  async function destination() {
    const file = await new App().vault.create("Original.md", "Original text.");
    const content = { text: "Original text.", focused: false };
    const editor = {
      getValue: () => content.text,
      getCursor: () => ({ line: 0, ch: 0 }),
      posToOffset: () => 0,
      replaceSelection: (text: string) => { content.text = text + content.text; },
      focus: () => { content.focused = true; },
    } as unknown as Editor;
    const view: NonNullable<Parameters<typeof insertReplyIntoNote>[0]> = {
      file, editor, getMode: () => "preview", getState: () => ({ file: file.path, mode: "preview" }), setState: async () => {},
    };
    return { view, content };
  }
  it("waits for the destination editor before making the insertion", async () => {
    const { view, content } = await destination();
    let release!: () => void;
    view.setState = () => new Promise<void>(resolve => { release = resolve; });
    const pending = insertReplyIntoNote(view, "## Findings");
    expect(content.text).toBe("Original text.");
    expect(content.focused).toBe(false);
    release();
    await pending;
    expect(content.text).toBe("## Findings\n\nOriginal text.");
    expect(content.focused).toBe(true);
  });
  it("leaves both notes untouched when the destination changes during the switch", async () => {
    const first = await destination();
    const second = await destination();
    let release!: () => void;
    first.view.setState = () => new Promise<void>(resolve => { release = resolve; });
    const pending = insertReplyIntoNote(first.view, "## Findings");
    first.view.file = second.view.file;
    first.view.editor = second.view.editor;
    release();
    await pending;
    expect(first.content.text).toBe("Original text.");
    expect(second.content.text).toBe("Original text.");
    expect(getNoticeMessages()).toContain("The destination note changed. Try inserting again.");
  });
  it("reports a failed switch without changing the note", async () => {
    const { view, content } = await destination();
    view.setState = async () => { throw new Error("Cannot open the editor"); };
    await insertReplyIntoNote(view, "## Findings");
    expect(content.text).toBe("Original text.");
    expect(getNoticeMessages()).toContain("Couldn't insert the reply: Cannot open the editor");
  });
  it("reports that no note is open without throwing", async () => {
    await insertReplyIntoNote(null, "## Findings");
    expect(getNoticeMessages()).toContain("Open a note to insert into.");
  });
});
