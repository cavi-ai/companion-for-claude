import { Notice, type App } from "obsidian";
import { maxBytesFor, sniffMime, type MediaAttachment } from "../../context/attachments";
import { quickNotice } from "../../notice";

export interface PastedImageHost {
  signal?: AbortSignal;
  app: Pick<App, "fileManager" | "vault">;
  sourcePath?: string | undefined;
  media(): MediaAttachment[];
  changed(): void;
}

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const cancelled = new WeakSet<MediaAttachment>();
export function cancelPastedImages(media: readonly MediaAttachment[]): void {
  for (const item of media) if (item.pending) { cancelled.add(item); delete item.pending; }
}

/** Store the image while its source item stays with its draft. */
export async function attachPastedImage(file: File, host: PastedImageHost): Promise<void> {
  if (host.signal?.aborted) return;
  const limit = maxBytesFor("image");
  if (file.size > limit) {
    new Notice(`Pasted image is too large to attach (max ${Math.round(limit / 1024 / 1024)} MB).`);
    return;
  }
  const item: MediaAttachment = { label: file.name || "Pasted image", kind: "image", mime: file.type || "image/png", pending: true };
  host.media().push(item);
  host.changed();
  try {
    const buf = await file.arrayBuffer();
    if (cancelled.has(item) || host.signal?.aborted) return;
    if (buf.byteLength > limit) throw new Error("The pasted image exceeds the attachment size limit.");
    const mime = sniffMime(buf) ?? (file.type || "image/png");
    const extension = EXTENSION[mime];
    if (!extension) throw new Error("Use a PNG, JPEG, GIF, or WebP image.");
    const name = (file.name.split(/[\\/]/).pop() || "Pasted image").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\p{Cc}]/gu, " ").trim() || "Pasted image";
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = await host.app.fileManager.getAvailablePathForAttachment(`${name}.${extension}`, host.sourcePath);
      if (cancelled.has(item) || host.signal?.aborted) return;
      try {
        await host.app.vault.createBinary(path, buf);
      } catch (error) {
        // Another paste can claim an available name before createBinary runs.
        if (attempt < 2 && host.app.vault.getAbstractFileByPath(path)) continue;
        throw error;
      }
      if (cancelled.has(item) || host.signal?.aborted) return;
      Object.assign(item, { label: path.split("/").pop() || name, mime, path });
      if (host.media().includes(item)) quickNotice("Image saved to your vault and attached to your next message.");
      return;
    }
  } catch (error) {
    if (cancelled.has(item) || host.signal?.aborted) return;
    item.error = error instanceof Error ? error.message : String(error);
    if (host.media().includes(item)) new Notice(`Couldn't attach the pasted image: ${item.error}`);
  } finally {
    delete item.pending;
    if (!host.signal?.aborted) host.changed();
  }
}


/** Preparation follows source objects across per-conversation draft snapshots. */
export class PastedImagePreparation {
  private readonly lifetime = new AbortController();
  constructor(private readonly current: () => MediaAttachment[]) {}

  get pending(): boolean { return this.current().some(item => item.pending); }

  ready(): boolean {
    if (!this.pending) return true;
    new Notice("Request not sent. An image is still attaching. Wait for it to finish, then send again.");
    return false;
  }

  dispose(): void { this.lifetime.abort(); }

  async attach(file: File, host: PastedImageHost): Promise<void> { await attachPastedImage(file, { ...host, signal: this.lifetime.signal }); }
}
