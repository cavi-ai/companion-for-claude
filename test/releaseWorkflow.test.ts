import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release mirror workflow", () => {
  it("prepares documentation for the standalone repository layout", async () => {
    const workflow = await readFile(path.resolve("../.github/workflows/release-obsidian-plugin.yml"), "utf8");
    expect(workflow).toContain("node obsidian-plugin/tools/prepare-release-docs.mjs . release-repo");
    expect(workflow).not.toMatch(/cp obsidian-plugin\/README\.md\s+release-repo\/README\.md/);
  });

  it("copies the pnpm workspace configuration with the frozen lockfile", async () => {
    const workflow = await readFile(
      path.resolve("../.github/workflows/release-obsidian-plugin.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "cp obsidian-plugin/pnpm-workspace.yaml release-repo/pnpm-workspace.yaml",
    );
  });
});
