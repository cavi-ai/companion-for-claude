import { describe, expect, it } from "vitest";
import { readTurnMedia, rememberTurnMedia, readTurnContext, rememberTurnContext, renameTurnContext } from "../../src/chat/turnSources";
import { toApiMessages } from "../../src/conversations/store";
import type { ChatMessage } from "../../src/types";

const image = { label: "Chart A", kind: "image" as const, mime: "image/png", path: "Chart A.png", data: "private-image-bytes" };
const question = (media = rememberTurnMedia([image])): ChatMessage => ({ role: "user", content: "Question A", media });

describe("accepted turn media", () => {
  it("keeps media on its question across histories and excludes it from text history payloads", () => {
    const a = question();
    const b: ChatMessage = { role: "user", content: "Text only B" };
    expect(readTurnMedia([a, { role: "assistant", content: "A" }, b])).toEqual([]);
    expect(readTurnMedia([a])).toEqual([image]);
    expect(toApiMessages([a])).toEqual([{ role: "user", content: "Question A" }]);
  });
  it("serializes only references and reopens vault media after reload", () => {
    const serialized = JSON.stringify(question());
    expect(serialized).not.toContain("private-image-bytes");
    expect(readTurnMedia([JSON.parse(serialized)])).toEqual([{ label: "Chart A", kind: "image", mime: "image/png", path: "Chart A.png" }]);
  });
  it("keeps live pasted bytes only for their own question and refuses expired bytes", () => {
    const { path: _path, ...pasted } = image;
    const message = question(rememberTurnMedia([pasted]));
    expect(readTurnMedia([message])[0]).toBe(pasted);
    expect(() => readTurnMedia([JSON.parse(JSON.stringify(message))])).toThrow("Paste it again and resend the question");
  });
  it("never accepts inline payloads injected into persisted references", () => {
    const persisted = JSON.parse(JSON.stringify(question()));
    persisted.media[0].data = "untrusted-inline-data";
    expect(readTurnMedia([persisted])[0]).not.toHaveProperty("data");
  });
  it.each([null, {}, [{ kind: "audio", label: "x", mime: "audio/mp3" }], [{ kind: "image", label: "x", mime: "image/png", path: 42 }]])("refuses malformed attachment records %j", (media) => {
    expect(() => readTurnMedia([{ role: "user", content: "A", media } as ChatMessage])).toThrow("Original attachments are invalid");
  });
});


describe("accepted note and page context", () => {
  it("snapshots source selection and page text independently of later composer changes", () => {
    const paths = [{ path: "A.md", kind: "note" as const }];
    const pages = [{ url: "https://example.test/a", title: "A", markdown: "Original A" }];
    const contextAttachments = rememberTurnContext(paths, pages);
    paths[0]!.path = "B.md";
    pages[0]!.markdown = "New B";
    const messages: ChatMessage[] = [{ role: "user", content: "Question A", contextAttachments }];
    expect(readTurnContext(JSON.parse(JSON.stringify(messages)))).toEqual({ paths: [{ path: "A.md", kind: "note" }], pages: [{ url: "https://example.test/a", title: "A", markdown: "Original A" }] });
    expect(toApiMessages(messages)).toEqual([{ role: "user", content: "Question A" }]);
  });
  it("keeps current empty selections distinct from legacy unsaved source references", () => {
    const legacy: ChatMessage = { role: "user", content: "A", contextSources: ["1 attached", "1 page"] };
    expect(() => readTurnContext([legacy])).toThrow("references were not saved");
    expect(readTurnContext([{ ...legacy, contextAttachments: { paths: [], pages: [] } }])).toEqual({ paths: [], pages: [] });
    expect(readTurnContext([{ role: "user", content: "Text only" }])).toEqual({ paths: [], pages: [] });
  });
  it("follows renamed note and folder references held in stale snapshots", () => {
    const original = rememberTurnContext([{ path: "Notes/A.md", kind: "note" }, { path: "Notes", kind: "folder" }], []);
    const moved = renameTurnContext(original, "Notes", "Archive");
    expect(original.paths[0]!.path).toBe("Notes/A.md");
    expect(readTurnContext([{ role: "user", content: "A", contextAttachments: original }])).toEqual(moved);
    expect(moved.paths.map(({ path }) => path)).toEqual(["Archive/A.md", "Archive"]);
  });
  it.each([null, {}, { paths: [], pages: [{ url: "file:///private", markdown: "x" }] }, { paths: [{ path: "A.md", kind: "image" }], pages: [] }])("refuses malformed original context %j", (contextAttachments) => {
    expect(() => readTurnContext([{ role: "user", content: "A", contextAttachments } as ChatMessage])).toThrow("references are invalid");
  });
  it("refuses unusable captures instead of silently dropping them", () => {
    expect(() => rememberTurnContext([], [{ url: "https://example.test/a", markdown: "", pending: true }])).toThrow("Still capturing");
  });
});
