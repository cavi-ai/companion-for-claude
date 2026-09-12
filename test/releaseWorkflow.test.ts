import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release mirror workflow", () => {
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
