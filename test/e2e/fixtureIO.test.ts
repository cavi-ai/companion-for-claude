import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { nativeFixtureIO } from "../../e2e/rig/pageOps";
import { seedVault } from "../../e2e/rig/seed";
import { assertOwnedVault } from "../../e2e/rig/ownership";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("fixture seeding IO", () => {
  it("routes all fixture folders, text and binary bytes through injected IO while keeping plugin state on fs", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-seed-")); roots.push(root);
    const vault = join(root, "vault"), build = join(root, "build");
    await mkdir(vault); await mkdir(build);
    for (const file of ["main.js", "manifest.json", "styles.css"]) await writeFile(join(build, file), file);
    const writes = new Map<string, string | Uint8Array>();
    const directories: string[] = [];
    await seedVault(vault, { providerPort: 1, endpointPort: 2, embedPort: 3, githubPort: 4 }, { extraFiles: { "Nested/Extra.md": "Exact extra\r\n" } }, build, {
      mkdir: async path => { directories.push(path); await mkdir(join(vault, path), { recursive: true }); },
      writeFile: async (path, content) => { writes.set(path, content); await writeFile(join(vault, path), content); },
    });
    expect(directories).toContain("Research/Alpha/Sources");
    expect(writes.get("Research/Alpha/Project.md")).toContain('type: "research-project"');
    expect(writes.get("Nested/Extra.md")).toBe("Exact extra\r\n");
    expect(Buffer.from(writes.get("Reference material with a deliberately long folder name/Figure.png") as Uint8Array)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect([...writes.keys()].some(path => path.startsWith(".obsidian"))).toBe(false);
    expect(await readFile(join(vault, ".obsidian/plugins/claude-companion/main.js"), "utf8")).toBe("main.js");
    const owned = await assertOwnedVault(vault);
    expect(Object.keys(owned.files)).toEqual([...writes.keys()].sort((a, b) => a.localeCompare(b)));
    const firstLaunchVault = join(root, "first-launch-vault");
    await mkdir(firstLaunchVault);
    await seedVault(firstLaunchVault, { providerPort: 1, endpointPort: 2, embedPort: 3, githubPort: 4 }, { extraFiles: { "Nested/Extra.md": "Exact extra\r\n" } }, build);
    expect(await assertOwnedVault(firstLaunchVault)).toEqual(owned);
  });
});

describe("native fixture API adapter", () => {
  function fixture(basePath = "/owned/vault") {
    const files = new Map<string, { path: string; children?: unknown[] }>();
    const vault = {
      adapter: { getBasePath: () => basePath },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: vi.fn(async (path: string) => { const folder = { path, children: [] }; files.set(path, folder); return folder; }),
      create: vi.fn(async (path: string, content: string) => { files.set(path, { path }); return { path, content }; }),
      createBinary: vi.fn(async (path: string, content: ArrayBuffer) => { files.set(path, { path }); return { path, content }; }),
      modify: vi.fn(async () => {}), modifyBinary: vi.fn(async () => {}),
      delete: vi.fn(async (file: { path: string }) => { files.delete(file.path); }),
    };
    vi.stubGlobal("window", { app: { vault } });
    const page = { evaluate: (callback: (input: unknown) => unknown, input: unknown) => callback(input) } as unknown as Page;
    return { vault, files, io: nativeFixtureIO(page, "/owned/vault") };
  }
  it("uses public native APIs for nested folders, text and exact binary bytes", async () => {
    const { io, vault } = fixture();
    await io.mkdir("Notes/Nested");
    await io.writeFile("Notes/Nested/Alpha.md", "Alpha\r\n");
    const buffer = Buffer.from([99, 1, 2, 88]).subarray(1, 3);
    await io.writeFile("Notes/Nested/File.png", buffer);
    expect(vault.createFolder.mock.calls).toEqual([["Notes"], ["Notes/Nested"]]);
    expect(vault.create).toHaveBeenCalledWith("Notes/Nested/Alpha.md", "Alpha\r\n");
    expect(new Uint8Array(vault.createBinary.mock.calls[0]![1])).toEqual(new Uint8Array([1, 2]));
    await io.deleteFile("Notes/Nested/Alpha.md");
    expect(vault.delete).toHaveBeenCalledWith({ path: "Notes/Nested/Alpha.md" });
  });
  it("refuses a different renderer vault before every native operation", async () => {
    const { io, vault } = fixture("/user/vault");
    for (const operation of [() => io.mkdir("Notes"), () => io.writeFile("Alpha.md", "A"), () => io.deleteFile("Alpha.md"), () => io.deleteDirectory("Notes")]) {
      await expect(operation()).rejects.toThrow(/vault|target/i);
    }
    expect(vault.createFolder).not.toHaveBeenCalled(); expect(vault.create).not.toHaveBeenCalled(); expect(vault.delete).not.toHaveBeenCalled();
  });
  it("rejects hidden state, traversal, wrong file types and nonempty folder deletion", async () => {
    const { io, files, vault } = fixture();
    for (const path of [".obsidian/app.json", "../User.md", "/User.md"]) await expect(io.writeFile(path, "A")).rejects.toThrow(/path|fixture/i);
    files.set("Notes", { path: "Notes", children: [{ path: "Notes/User.md" }] });
    await expect(io.deleteDirectory("Notes")).rejects.toThrow(/empty/i);
    await expect(io.deleteFile("Notes")).rejects.toThrow(/file/i);
    expect(vault.delete).not.toHaveBeenCalled();
  });
  it("uses the native folder flag only after verifying that the owned folder is empty", async () => {
    const { io, files, vault } = fixture();
    const folder = { path: "Empty", children: [] };
    files.set("Empty", folder);
    await io.deleteDirectory("Empty");
    expect(vault.delete).toHaveBeenCalledWith(folder, true);
  });
});
