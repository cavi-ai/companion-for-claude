import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sourceInput } from "./releaseLayout";

describe("release mirror workflow", () => {
  it("prepares documentation for the standalone repository layout", async () => {
    const workflow = await readFile(sourceInput(".github/workflows/release-obsidian-plugin.yml"), "utf8");
    expect(workflow).toContain("node obsidian-plugin/tools/prepare-release-docs.mjs . release-repo");
    expect(workflow).not.toMatch(/cp obsidian-plugin\/README\.md\s+release-repo\/README\.md/);
  });

  it("copies the pnpm workspace configuration with the frozen lockfile", async () => {
    const workflow = await readFile(
      sourceInput(".github/workflows/release-obsidian-plugin.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "cp obsidian-plugin/pnpm-workspace.yaml release-repo/pnpm-workspace.yaml",
    );
  });
});
