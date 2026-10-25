import { Platform } from "obsidian";

export interface ClipperJsonFile {
  fileName: string;
  mimeType: "application/json";
  json: string;
}

/** Export the actual JSON file, rather than sharing an Obsidian Markdown note. */
export async function saveClipperJson(artifact: ClipperJsonFile): Promise<boolean> {
  const file = new File([artifact.json], artifact.fileName, { type: artifact.mimeType });
  if (Platform.isMobile) {
    if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) {
      throw new Error("File export is unavailable. Copy template JSON, then use Web Clipper → Import → JSON and paste it there.");
    }
    try { await navigator.share({ files: [file] }); return true; }
    catch (error) { if (error instanceof Error && error.name === "AbortError") return false; throw error; }
  }
  const url = URL.createObjectURL(file);
  const link = activeDocument.body.createEl("a");
  link.href = url;
  link.download = artifact.fileName;
  try { link.click(); }
  finally { link.remove(); URL.revokeObjectURL(url); }
  return true;
}
