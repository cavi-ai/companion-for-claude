import { afterEach, describe, expect, it } from "vitest";
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
});
