import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { applyOrganizeMoves } from "../../src/sources/organizeApply";
import type { OrganizeMove } from "../../src/sources/organize";

describe("applyOrganizeMoves", () => {
  it("continues past a rejected rename and reports it", async () => {
    const app = new App();
    app.vault.seed("Clippings/a.md", "A");
    app.vault.seed("Clippings/b.md", "B");
    const moves: OrganizeMove[] = [
      { from: "Clippings/a.md", to: "Library/x/A.md", title: "A", domain: "x" },
      { from: "Clippings/b.md", to: "Library/x/B.md", title: "B", domain: "x" },
    ];
    const spy = vi.spyOn(app.fileManager, "renameFile").mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    const result = await applyOrganizeMoves(app, moves);

    expect(result.moved).toBe(1);
    expect(result.failed).toEqual([{ from: "Clippings/a.md", error: "disk full" }]);
    expect(app.vault.getAbstractFileByPath("Library/x/B.md")).not.toBeNull();
    spy.mockRestore();
  });

  it("counts a missing source as failed without throwing", async () => {
    const app = new App();
    const moves: OrganizeMove[] = [{ from: "Clippings/gone.md", to: "Library/x/Gone.md", title: "Gone", domain: "x" }];

    const result = await applyOrganizeMoves(app, moves);

    expect(result.moved).toBe(0);
    expect(result.failed).toEqual([{ from: "Clippings/gone.md", error: "note no longer exists" }]);
  });
});
