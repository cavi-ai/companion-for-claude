// A test fixture owns only its recorded files, never an entire arbitrary vault.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Snapshot { files: Record<string, string>; directories: string[] }
const manifestPath = (vault: string): string => join(dirname(vault), "vault-ownership.json");

async function snapshot(vault: string): Promise<Snapshot> {
  const result: Snapshot = { files: {}, directories: [] };
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(vault, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && entry.name === ".obsidian") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Refusing fixture ownership of a symbolic link: ${path}`);
      if (entry.isDirectory()) { result.directories.push(path); await visit(path); }
      else if (entry.isFile()) result.files[path] = createHash("sha256").update(await readFile(join(vault, path))).digest("hex");
      else throw new Error(`Unowned fixture entry: ${path}`);
    }
  }
  const info = await lstat(vault);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The fixture vault must be a real directory.");
  await visit("");
  return result;
}

/** Call only after seeding, or at the end of an exclusively owned test scenario. */
export async function recordVaultOwnership(vault: string): Promise<void> {
  await writeFile(manifestPath(vault), JSON.stringify(await snapshot(vault)));
}

export async function assertOwnedVault(vault: string): Promise<Snapshot> {
  let expected: unknown;
  try { expected = JSON.parse(await readFile(manifestPath(vault), "utf8")); }
  catch { throw new Error("Missing fixture ownership. Refusing to reset an unowned vault."); }
  const actual = await snapshot(vault);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("The fixture contains changed or unowned files. Nothing was deleted. Use an empty, dedicated CC_E2E_ROOT.");
  }
  return actual;
}

export interface VaultDeletion {
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
}

export async function resetOwnedVault(vault: string, deletion?: VaultDeletion): Promise<void> {
  const owned = await assertOwnedVault(vault);
  const io = deletion ?? {
    deleteFile: async (path: string) => { await rm(join(vault, path)); },
    deleteDirectory: async (path: string) => { await rmdir(join(vault, path)); },
  };
  for (const path of Object.keys(owned.files)) await io.deleteFile(path);
  for (const path of owned.directories.sort((a, b) => b.length - a.length)) await io.deleteDirectory(path);
}

/** Never erase the shared rig root at launch, especially after somebody added real notes. */
export async function prepareRigRoot(root: string): Promise<void> {
  const marker = join(root, "fixture-owner.json");
  let exists = false;
  try { exists = (await readdir(root)).length > 0; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    const owner = await readFile(marker, "utf8").catch(() => "");
    if (owner !== "companion-e2e-v1") throw new Error("Unowned rig root. Use an empty, dedicated CC_E2E_ROOT; existing data was preserved.");
    await resetOwnedVault(join(root, "vault"));
  }
  await mkdir(root, { recursive: true });
  await writeFile(marker, "companion-e2e-v1");
}
