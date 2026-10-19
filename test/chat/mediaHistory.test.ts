import { expect, it } from "vitest";
import { toApiMessages } from "../../src/conversations/store";
import type { ChatMessage } from "../../src/types";
import { historyHasMedia, loadHistoryMedia, projectRequestMessages } from "../../src/chat/mediaHistory";
import { rememberTurnMedia } from "../../src/chat/turnSources";
import { turnHistory } from "../../src/chat/turnStart";
import type { ContentBlock } from "../../src/providers/types";
const image: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "original-image" } };

it("projects earlier media before coalescing roles without sending stored metadata", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "First chart", contextSources: ["private-metadata"] }, { role: "user", content: "Follow-up" }];
  const wire = toApiMessages(messages, message => message === messages[0] ? [image, { type: "text", text: message.content }] : message.content);
  expect(wire).toEqual([{ role: "user", content: [image, { type: "text", text: "First chart\n\nFollow-up" }] }]);
  expect(JSON.stringify(wire)).not.toContain("private-metadata");
  expect(messages[0]?.content).toBe("First chart");
});

it("never projects excluded media into a later request", () => {
  const wire = toApiMessages([{ role: "user", content: "Excluded chart", contextExcluded: true }, { role: "user", content: "New question" }], message => message.contextExcluded ? [image] : message.content);
  expect(wire).toEqual([{ role: "user", content: "New question" }]);
});

it("loads earlier images once and associates their blocks with the original question", async () => {
  const media = rememberTurnMedia([{ label: "Original.png", kind: "image", mime: "image/png", data: "original-image" }]);
  const messages: ChatMessage[] = [{ role: "user", content: "Original question", media }, { role: "assistant", content: "Original answer" }];
  const loaded = await loadHistoryMedia(messages, async sources => {
    expect(sources[0]?.data).toBe("original-image");
    return [image];
  });
  const request = projectRequestMessages([...messages, { role: "user", content: "Follow-up" }], loaded, [], "New context");
  expect(request).toEqual([
    { role: "user", content: [image, { type: "text", text: "Original question" }] },
    { role: "assistant", content: "Original answer" },
    { role: "user", content: "New context\n\n---\n\nFollow-up" },
  ]);
  expect(JSON.stringify(messages)).not.toContain("original-image");
  expect(historyHasMedia(messages)).toBe(true);
});

it("skips excluded media and does not require files from the request being replaced", async () => {
  const media = rememberTurnMedia([{ label: "Original.png", kind: "image", mime: "image/png", path: "Original.png" }]);
  const original: ChatMessage[] = [{ role: "user", content: "Original", media }, { role: "assistant", content: "Answer" }];
  const history = turnHistory({ messages: original, previousTurn: undefined, regenerate: true }).messages;
  expect(historyHasMedia(history)).toBe(false);
  expect(await loadHistoryMedia([...history, { ...original[0]!, contextExcluded: true }], async () => { throw new Error("Excluded source must not load"); })).toEqual(new Map());
});

it("rejects unavailable earlier sources with a recoverable action before projection", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Old chart", media: [{ label: "Lost.png", kind: "image", mime: "image/png", path: "Lost.png" }] }];
  await expect(loadHistoryMedia(messages, async () => { throw new Error("File not found"); })).rejects.toThrow("Earlier attachment Lost.png");
});

it("rejects expired inline history and keeps excluded malformed history inert", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Old chart", media: [{ label: "Pasted", kind: "image", mime: "image/png" }] }];
  await expect(loadHistoryMedia(messages, async () => [])).rejects.toThrow("new chat");
  expect(historyHasMedia([{ ...messages[0]!, contextExcluded: true }])).toBe(false);
});

it("combines current image/context without replacing earlier image blocks", async () => {
  const oldRefs = rememberTurnMedia([{ label: "Old.png", kind: "image", mime: "image/png", data: "original-image" }]);
  const next: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "next-image" } };
  const messages: ChatMessage[] = [{ role: "user", content: "Old question", media: oldRefs }, { role: "assistant", content: "Old answer" }, { role: "user", content: "Next question" }];
  const result = projectRequestMessages(messages, new Map([[oldRefs, [image]]]), [next], "Selected context");
  expect(result[0]?.content).toEqual([image, { type: "text", text: "Old question" }]);
  expect(result[2]?.content).toEqual([next, { type: "text", text: "Selected context\n\n---\n\nNext question" }]);
});
