import { describe, expect, it } from "vitest";
import { ConversationDrafts } from "../../src/view/chat/conversationDrafts";
import type { Composer } from "../../src/view/chat/Composer";
import { draftContextState } from "../../src/view/chat/draftContextState";

const OFF = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

function fixture() {
  const input = { value: "" };
  const composer = { inputEl: input, draft: () => input.value, autosizeInput: () => undefined, contextToggles: { ...OFF }, attachedPaths: [], attachedMedia: [], attachedPages: [], renderContextManager: () => undefined } as unknown as Composer;
  return { input, composer, drafts: new ConversationDrafts(() => composer) };
}

describe("conversation draft view state", () => {
  it("keeps each question with its own sources while preserving tab-wide context", () => {
    const { input, composer, drafts } = fixture();
    input.value = "Question A";
    composer.attachedPaths = [{ path: "A.md", kind: "note" }];
    composer.attachedMedia = [{ label: "Image A", kind: "image", mime: "image/png", data: "live-image-data" }];
    composer.contextToggles.searchVault = true;
    drafts.switchTo("a", "b");
    expect(input.value).toBe("");
    expect(composer.attachedPaths).toEqual([]);
    expect(composer.attachedMedia).toEqual([]);
    expect(composer.contextToggles.searchVault).toBe(true);
    input.value = "Question B";
    composer.attachedPaths = [{ path: "B.md", kind: "note" }];
    drafts.switchTo("b", "a");
    expect(input.value).toBe("Question A");
    expect(composer.attachedPaths).toEqual([{ path: "A.md", kind: "note" }]);
    expect(composer.attachedMedia[0]?.data).toBe("live-image-data");
    expect(composer.contextToggles.searchVault).toBe(true);
    drafts.switchTo("a", "b");
    expect(input.value).toBe("Question B");
    expect(composer.attachedPaths).toEqual([{ path: "B.md", kind: "note" }]);
  });

  it("persists inactive draft contexts without inline image bytes", () => {
    const original = fixture();
    original.input.value = "Question A";
    original.composer.attachedPaths = [{ path: "A.md", kind: "note" }];
    original.composer.attachedMedia = [{ label: "A", path: "A.png", kind: "image", mime: "image/png", data: "private-image-data" }];
    original.drafts.switchTo("a", "b");
    original.input.value = "Question B";
    original.composer.attachedPaths = [{ path: "B.md", kind: "note" }];
    const serialized = JSON.stringify({ ...original.drafts.getState("b"), ...draftContextState(original.composer, OFF) });
    expect(serialized).not.toContain("private-image-data");
    const reopened = fixture();
    reopened.drafts.restore(JSON.parse(serialized), "b");
    expect(reopened.composer.attachedPaths).toEqual([{ path: "B.md", kind: "note" }]);
    reopened.drafts.switchTo("b", "a");
    expect(reopened.input.value).toBe("Question A");
    expect(reopened.composer.attachedPaths).toEqual([{ path: "A.md", kind: "note" }]);
    expect(reopened.composer.attachedMedia).toEqual([{ label: "A", path: "A.png", kind: "image", mime: "image/png" }]);
  });

  it("keeps a page capture connected to its inactive draft while it completes", () => {
    const { composer, drafts } = fixture();
    const page = { url: "https://example.test/a", markdown: "", pending: true };
    composer.attachedPages = [page];
    drafts.switchTo("a", "b");
    expect(composer.attachedPages).toEqual([]);
    page.pending = false;
    page.markdown = "Captured A";
    drafts.switchTo("b", "a");
    expect(composer.attachedPages).toEqual([{ url: "https://example.test/a", markdown: "Captured A", pending: false }]);
  });

  it("keeps empty state compatible with existing workspace layouts", () => {
    const { drafts } = fixture();
    expect(drafts.getState(null)).toEqual({ conversationId: null });
  });

  it("keeps whitespace and line breaks in the current snapshot", () => {
    const { input, drafts } = fixture();
    input.value = "  Questions\nDetails  ";
    expect(drafts.getState(null)).toEqual({ conversationId: null, drafts: [{ conversationId: null, text: "  Questions\nDetails  " }] });
  });

  it("skips malformed entries without losing valid drafts", () => {
    const { input, drafts } = fixture();
    drafts.restore({ drafts: [null, 3, [], { conversationId: 4, text: "bad owner" }, { conversationId: "bad", text: [] }, { conversationId: "good", text: "Saved question" }] }, "good");
    expect(input.value).toBe("Saved question");
    drafts.switchTo("good", "bad");
    expect(input.value).toBe("");
  });

  it("leaves the current draft alone when legacy state has no draft snapshot", () => {
    const { input, drafts } = fixture();
    input.value = "Current question";
    drafts.restore({ conversationId: "a" }, "a");
    expect(input.value).toBe("Current question");
  });

  it("does not restore a consumed draft", () => {
    const { input, drafts } = fixture();
    input.value = "Submitted question";
    drafts.switchTo("a", "b");
    drafts.consume("a");
    const snapshot = JSON.parse(JSON.stringify(drafts.getState("b"))) as unknown;
    const reopened = fixture();
    reopened.drafts.restore(snapshot, "b");
    reopened.drafts.switchTo("b", "a");
    expect(reopened.input.value).toBe("");
  });
});
