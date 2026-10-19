import type { ChatMessage } from "../types";
import type { MediaAttachment } from "../context/attachments";
import type { ApiMessage, ContentBlock } from "../providers/types";
import { compactArtifactsInHistory, toApiMessages } from "../conversations/store";
import { readTurnMedia } from "./turnSources";

type MediaRefs = NonNullable<ChatMessage["media"]>;
export type HistoryMedia = ReadonlyMap<MediaRefs, readonly ContentBlock[]>;
const included = (message: ChatMessage) => message.role === "user" && !message.contextExcluded && message.media !== undefined;

export function historyHasMedia(messages: readonly ChatMessage[]): boolean {
  return messages.some(message => included(message) && (!Array.isArray(message.media) || message.media.length > 0));
}

/** Prepare included earlier sources before acceptance; excluded turns never perform IO. */
export async function loadHistoryMedia(messages: readonly ChatMessage[], load: (media: readonly MediaAttachment[]) => Promise<readonly ContentBlock[]>): Promise<HistoryMedia> {
  const prepared = new Map<MediaRefs, readonly ContentBlock[]>();
  for (const message of messages) {
    if (!included(message) || prepared.has(message.media!)) continue;
    let sources: MediaAttachment[];
    try { sources = readTurnMedia([message]); }
    catch (error) { throw new Error("Earlier attachments are unavailable. Start a new chat and attach your sources again.", { cause: error }); }
    const blocks: ContentBlock[] = [];
    for (const source of sources) {
      try { blocks.push(...await load([source])); }
      catch (error) { throw new Error(`Earlier attachment ${source.label} could not be loaded. Restore its original file, or start a new chat and attach it again.`, { cause: error }); }
    }
    prepared.set(message.media!, blocks);
  }
  return prepared;
}

/** Media stays with its original user message; only the current question gets new context. */
export function projectRequestMessages(messages: ChatMessage[], history: HistoryMedia, currentMedia: readonly ContentBlock[], context: string): ApiMessage[] {
  const current = messages.at(-1);
  return toApiMessages(compactArtifactsInHistory(messages), message => {
    const blocks = message === current ? currentMedia : message.media ? history.get(message.media) ?? [] : [];
    const text = message === current && context ? `${context}\n\n---\n\n${message.content}` : message.content;
    return blocks.length ? [...blocks, { type: "text", text }] : text;
  });
}
