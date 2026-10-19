import { TFile, type App } from "obsidian";
import { arrayBufferToBase64, maxBytesFor, mediaBlock, sniffMime, type MediaAttachment } from "../../context/attachments";
import type { ContentBlock } from "../../providers/types";

/** Load the complete selected set before accepting a turn; never silently omit a file. */
export async function loadMediaBlocks(app: Pick<App, "vault">, media: readonly MediaAttachment[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const item of media) {
    try {
      if (item.pending) throw new Error("image is still attaching; wait for it to finish");
      if (item.error) throw new Error(item.error);
      let data = item.data;
      let mime = item.mime;
      if (!data && item.path) {
        const file = app.vault.getAbstractFileByPath(item.path);
        if (!(file instanceof TFile)) throw new Error("file not found");
        const limit = maxBytesFor(item.kind);
        if (file.stat.size > limit) throw new Error(`file is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
        const bytes = await app.vault.readBinary(file);
        if (bytes.byteLength > limit) throw new Error(`file is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
        mime = sniffMime(bytes) ?? mime;
        data = arrayBufferToBase64(bytes);
      }
      if (!data) throw new Error("file is empty");
      blocks.push(mediaBlock(item.kind, mime, data));
    } catch (error) {
      throw new Error(`Couldn't attach ${item.label}: ${error instanceof Error ? error.message : String(error)}. Reattach it or remove it from Message context, then send again.`, { cause: error });
    }
  }
  return blocks;
}
