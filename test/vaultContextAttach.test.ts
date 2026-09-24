import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { gatherContext } from "../src/context/vaultContext";
import { DEFAULT_SETTINGS } from "../src/types";

const NO_TOGGLES = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

function app(): App {
  const a = new App();
  a.vault.seed("DB/Tracker.base", "views:\n  - type: table\n");
  a.workspace = { getActiveViewOfType: () => null, getActiveFile: () => null } as never;
  return a;
}

describe("gatherContext — attached .base path", () => {
  it("reads a .base file's content into the context text", async () => {
    const ctx = await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [{ path: "DB/Tracker.base", kind: "note" }]);
    expect(ctx.text).toContain("Attached: DB/Tracker.base");
    expect(ctx.text).toContain("views:\n  - type: table");
    expect(ctx.sources).toEqual(["1 attached"]);
  });
});
