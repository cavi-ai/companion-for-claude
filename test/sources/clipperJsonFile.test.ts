import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { saveClipperJson } from "../../src/sources/clipperJsonFile";

const artifact = { fileName: "companion-article-clipper.json", mimeType: "application/json" as const, json: '{"name":"Companion: article"}\n' };
afterEach(() => { Platform.isMobile = false; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("saving Clipper JSON to the device", () => {
  it("shares a JSON File with the exact bytes and extension on mobile", async () => {
    Platform.isMobile = true;
    let shared: File | undefined;
    vi.stubGlobal("navigator", { canShare: () => true, share: async (data: { files: File[] }) => { shared = data.files[0]; } });
    expect(await saveClipperJson(artifact)).toBe(true);
    expect(shared?.name).toBe("companion-article-clipper.json");
    expect(shared?.type).toBe("application/json");
    expect(await shared?.text()).toBe(artifact.json);
  });

  it("does not report cancellation as a saved file", async () => {
    Platform.isMobile = true;
    vi.stubGlobal("navigator", { canShare: () => true, share: async () => { throw new DOMException("Cancelled", "AbortError"); } });
    expect(await saveClipperJson(artifact)).toBe(false);
  });

  it("explains the JSON text import when mobile file sharing is unavailable", async () => {
    Platform.isMobile = true;
    vi.stubGlobal("navigator", {});
    await expect(saveClipperJson(artifact)).rejects.toThrow(/Import.*JSON/);
  });

  it("downloads JSON bytes with a .json filename and revokes the temporary URL", async () => {
    let downloaded = "";
    let blob!: Blob;
    const link = { href: "", download: "", click: () => { downloaded = link.download; }, remove: vi.fn() };
    vi.stubGlobal("activeDocument", { body: { createEl: () => link } });
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => { blob = value as Blob; return "blob:clipper-test"; });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    expect(await saveClipperJson(artifact)).toBe(true);
    expect(downloaded).toBe("companion-article-clipper.json");
    expect(blob.type).toBe("application/json");
    expect(await blob.text()).toBe(artifact.json);
    expect(revoke).toHaveBeenCalledWith("blob:clipper-test");
  });
});
