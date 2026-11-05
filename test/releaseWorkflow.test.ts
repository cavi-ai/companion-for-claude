import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("exports the complete release package, including locked workspace configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-package-"));
  const source = join(root, "source"); const output = join(root, "output");
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts", "esbuild.config.mjs", "eslint.config.mjs", "main.js", "manifest.json", "styles.css", "versions.json"];
  try {
    await mkdir(source);
    for (const file of files) await writeFile(join(source, file), `fixture for ${file}\n`);
    const result = spawnSync(process.execPath, ["tools/prepare-release-package.mjs", source, output], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const file of files) expect(await readFile(join(output, file), "utf8")).toBe(`fixture for ${file}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
