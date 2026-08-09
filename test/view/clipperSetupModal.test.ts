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
  it("copies import JSON, shows exact instructions, and starts waiting without claiming success", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const onCopied = vi.fn().mockResolvedValue(undefined);
    const modal = new ClipperSetupModal(new App(), { setups, copyText, onCopied });
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;

    expect(root.querySelectorAll(".cc-clipper-tab")).toHaveLength(3);
    expect(root.querySelector(".cc-clipper-instructions")?.textContent).toContain("paste the JSON");
    expect(root.querySelector(".cc-clipper-verification")?.textContent).toBe("Waiting for a test clip after you copy this template.");

    root.querySelectorAll("button").find(({ textContent }) => textContent === "Copy template JSON")
      ?.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": "0.1.0"'));
    expect(onCopied).toHaveBeenCalledWith("article", setups()[0]!.fingerprint);
    expect(root.querySelector(".cc-clipper-verification")?.textContent).not.toContain("Verified");
  });
});
