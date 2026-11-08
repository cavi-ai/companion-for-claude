import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordVaultOwnership, resetOwnedVault } from "../e2e/rig/ownership";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function vault() { const root = await mkdtemp(join(tmpdir(), "companion-fixture-")); roots.push(root); const vault = join(root, "vault"); await mkdir(vault); return vault; }

describe("native fixture ownership", () => {
  it("refuses to reset an unmarked vault or one with an added user note", async () => {
    const path = await vault();
    await writeFile(join(path, "User.md"), "Unique notes");
    await expect(resetOwnedVault(path)).rejects.toThrow(/ownership|unowned/i);
    expect(await readFile(join(path, "User.md"), "utf8")).toBe("Unique notes");
    await recordVaultOwnership(path);
    await writeFile(join(path, "New user.md"), "Annotations");
    await expect(resetOwnedVault(path)).rejects.toThrow(/changed|unowned/i);
    expect(await readFile(join(path, "User.md"), "utf8")).toBe("Unique notes");
  });
  it("preserves a user edit to an otherwise owned note", async () => {
    const path = await vault();
    await writeFile(join(path, "Owned.md"), "Fixture");
    await recordVaultOwnership(path);
    await writeFile(join(path, "Owned.md"), "User revision");
    await expect(resetOwnedVault(path)).rejects.toThrow(/changed|unowned/i);
    expect(await readFile(join(path, "Owned.md"), "utf8")).toBe("User revision");
  });
  it("cleans owned notes and empty folders while preserving Obsidian state", async () => {
    const path = await vault();
    await mkdir(join(path, "Notes")); await writeFile(join(path, "Notes", "Owned.md"), "Fixture");
    await mkdir(join(path, ".obsidian")); await writeFile(join(path, ".obsidian", "user.json"), "{}");
    await recordVaultOwnership(path);
    await resetOwnedVault(path);
    expect(await readFile(join(path, ".obsidian", "user.json"), "utf8")).toBe("{}");
    await expect(readFile(join(path, "Notes", "Owned.md"))).rejects.toThrow();
  });
  it("never traverses a linked folder", async () => {
    const path = await vault();
    const outside = await vault(); await writeFile(join(outside, "User.md"), "Keep");
    await symlink(outside, join(path, "Linked"));
    await expect(recordVaultOwnership(path)).rejects.toThrow(/link/i);
    expect(await readFile(join(outside, "User.md"), "utf8")).toBe("Keep");
  });
  it("checks exact ownership before invoking native deletion callbacks", async () => {
    const path = await vault();
    await writeFile(join(path, "Owned.md"), "Fixture");
    await recordVaultOwnership(path);
    await writeFile(join(path, "Owned.md"), "User edit");
    const deletion = { deleteFile: vi.fn(), deleteDirectory: vi.fn() };
    await expect(resetOwnedVault(path, deletion)).rejects.toThrow(/changed|unowned/i);
    expect(deletion.deleteFile).not.toHaveBeenCalled();
    expect(deletion.deleteDirectory).not.toHaveBeenCalled();
  });
  it("awaits owned file deletions before deleting empty folders deepest first", async () => {
    const path = await vault();
    await mkdir(join(path, "Notes", "Nested"), { recursive: true });
    await writeFile(join(path, "Notes", "Nested", "Owned.md"), "Fixture");
    await mkdir(join(path, ".obsidian"));
    await writeFile(join(path, ".obsidian", "app.json"), "{}");
    await recordVaultOwnership(path);
    const order: string[] = [];
    await resetOwnedVault(path, {
      deleteFile: async relative => { order.push(relative); await rm(join(path, relative)); },
      deleteDirectory: async relative => { order.push(relative); await rm(join(path, relative), { recursive: true }); },
    });
    expect(order).toEqual(["Notes/Nested/Owned.md", "Notes/Nested", "Notes"]);
    expect(await readFile(join(path, ".obsidian", "app.json"), "utf8")).toBe("{}");
  });
});
