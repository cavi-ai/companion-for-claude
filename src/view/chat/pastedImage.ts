import { Notice } from "obsidian";
import { arrayBufferToBase64, maxBytesFor, sniffMime, type MediaAttachment } from "../../context/attachments";
import { quickNotice } from "../../notice";

export interface PastedImageHost {
  media(): MediaAttachment[];
  changed(): void;
}

/** A reset replaces the media collection, invalidating reads from the old chat. */
export async function attachPastedImage(file: File, host: PastedImageHost): Promise<void> {
  if (file.size > maxBytesFor("image")) {
    new Notice(`Pasted image is too large to attach (max ${Math.round(maxBytesFor("image") / 1024 / 1024)} MB).`);
    return;
  }
  const media = host.media();
  const buf = await file.arrayBuffer();
  if (media !== host.media()) return;
  const data = arrayBufferToBase64(buf);
  const n = media.filter((m) => !m.path).length + 1;
  media.push({ label: file.name || `Pasted image ${n}`, kind: "image", mime: sniffMime(buf) ?? (file.type || "image/png"), data });
  host.changed();
  quickNotice("Image attached to your next message.");
}
