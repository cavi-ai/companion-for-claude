import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { ensureVaultFolder, uniqueNotePath } from "../../src/vault/vaultFiles";

describe("ensureVaultFolder", () => {
  it("creates nested folders segment by segment", async () => {
    const app = new App();
    await ensureVaultFolder(app, "a/b/c");
    expect(app.vault.getAbstractFileByPath("a")).toBeTruthy();
    expect(app.vault.getAbstractFileByPath("a/b")).toBeTruthy();
    expect(app.vault.getAbstractFileByPath("a/b/c")).toBeTruthy();
  });

  it("is a no-op for root-ish and existing paths", async () => {
    const app = new App();
    app.vault.seed("x/y.md", "hi");
    await ensureVaultFolder(app, "");
    await ensureVaultFolder(app, "/");
    await ensureVaultFolder(app, "x"); // exists already
    expect(app.vault.getAbstractFileByPath("x/y.md")).toBeTruthy();
  });
});

describe("uniqueNotePath", () => {
  it("returns the plain path when free, suffixed on collision", async () => {
    const app = new App();
    expect(await uniqueNotePath(app, "N", "Title", "md")).toBe("N/Title.md");
    app.vault.seed("N/Title.md", "x");
    expect(await uniqueNotePath(app, "N", "Title", "md")).toBe("N/Title 2.md");
    app.vault.seed("N/Title 2.md", "x");
    expect(await uniqueNotePath(app, "N", "Title", "md")).toBe("N/Title 3.md");
  });

  it("honors a custom first suffix (memory notes start at 1)", async () => {
    const app = new App();
    app.vault.seed("M/Sess.md", "x");
    expect(await uniqueNotePath(app, "M", "Sess", "md", 1)).toBe("M/Sess 1.md");
  });

  it("handles a root-level folder", async () => {
    const app = new App();
    expect(await uniqueNotePath(app, "", "Top", "md")).toBe("Top.md");
  });
});
