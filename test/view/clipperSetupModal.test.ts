import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { clipperSetupFor } from "../../src/sources/clipperSetup";
import { getSchema } from "../../src/sources/registry";
import { ClipperSetupModal } from "../../src/view/ClipperSetupModal";

const setups = () => {
  const schemas = (["article", "video", "dataset"] as const).map((type) => getSchema(type));
  return (["article", "video", "dataset"] as const).map((type) => clipperSetupFor(type, schemas, {
    inboxFolder: "Clippings", baseTags: ["source"], savedFingerprint: "",
  }));
};

describe("ClipperSetupModal", () => {
  it("copies Properties import JSON without starting template verification", async () => {
    let copied = "";
    const onCopied = vi.fn();
    const modal = new ClipperSetupModal(new App(), { setups, copyText: (text) => { copied = text; }, onCopied });
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const button = root.querySelectorAll("button").find(({ textContent }) => textContent === "Copy property types JSON");
    expect(button).toBeDefined();
    button!.dispatchEvent({ type: "click" });
    await Promise.resolve();
    expect(JSON.parse(copied)).toMatchObject({ types: { schema_version: "number", source: "text" } });
    expect(onCopied).not.toHaveBeenCalled();
    expect(root.querySelector(".cc-clipper-properties-status")?.textContent).toContain("Properties → Import");
  });

  it("saves the Properties artifact rather than the template shown above it", async () => {
    let saved: { json: string; fileName: string } | undefined;
    const onCopied = vi.fn();
    const modal = new ClipperSetupModal(new App(), { setups, copyText: vi.fn(), onCopied,
      saveJson: async (artifact) => { saved = artifact; return true; } });
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const button = root.querySelectorAll("button").find(({ textContent }) => textContent === "Save property types JSON");
    expect(button).toBeDefined();
    button!.dispatchEvent({ type: "click" });
    await Promise.resolve();
    expect(saved?.fileName).toBe("companion-article-properties.json");
    expect(JSON.parse(saved!.json)).toMatchObject({ types: { tags: "multitext", author: "text" } });
    expect(onCopied).not.toHaveBeenCalled();
    expect(root.querySelector(".cc-clipper-properties-status")?.textContent).toContain("Properties → Import");
  });

  it("copies import JSON, shows exact instructions, and starts waiting without claiming success", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const onCopied = vi.fn().mockResolvedValue(undefined);
    const modal = new ClipperSetupModal(new App(), { setups, copyText, onCopied });
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;

    expect(root.querySelectorAll(".cc-clipper-tab")).toHaveLength(3);
    expect(root.querySelector(".cc-clipper-instructions")?.textContent).toContain("Import");
    expect(root.querySelector(".cc-clipper-instructions")?.textContent).toContain("not into a template field");
    expect(root.querySelector(".cc-clipper-verification")?.textContent).toBe("Waiting for a test clip after you copy this template.");

    root.querySelectorAll("button").find(({ textContent }) => textContent === "Copy template JSON")
      ?.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": "0.1.0"'));
    expect(onCopied).toHaveBeenCalledWith("article", setups()[0]!.fingerprint);
    expect(root.querySelector(".cc-clipper-verification")?.textContent).not.toContain("Verified");
  });

  it("leads with the file save the clipper's import actually reads, and waits on it", async () => {
    const onCopied = vi.fn().mockResolvedValue(undefined);
    const saveJson = vi.fn().mockResolvedValue(undefined);
    const modal = new ClipperSetupModal(new App(), { setups, copyText: vi.fn(), onCopied, saveJson });
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;

    const save = root.querySelectorAll("button").find(({ textContent }) => textContent === "Save JSON file");
    expect(save?.classList.has("mod-cta")).toBe(true);
    save?.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();

    expect(saveJson).toHaveBeenCalledWith(expect.objectContaining({ type: "article" }));
    expect(onCopied).toHaveBeenCalledWith("article", setups()[0]!.fingerprint);
  });
});
