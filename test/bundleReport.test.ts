import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("tools/bundle-report.mjs");
const temporaryDirectories: string[] = [];

async function writeMetafile(bytes: number): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "companion-bundle-report-"));
  temporaryDirectories.push(directory);
  const metafile = path.join(directory, "meta.json");
  await writeFile(metafile, JSON.stringify({
    outputs: {
      "main.js": {
        bytes,
        inputs: {
          "src/main.ts": { bytesInOutput: bytes },
        },
      },
    },
  }));
  return metafile;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bundle report", () => {
  it("fails the check when main.js exceeds the configured byte budget", async () => {
    const metafile = await writeMetafile(101);

    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--meta", metafile,
      "--check",
      "--max-bytes", "100",
    ], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main.js exceeds the 100 byte bundle budget by 1 byte");
  });

  it("accepts a bundle exactly at the configured byte budget", async () => {
    const metafile = await writeMetafile(100);

    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--meta", metafile,
      "--check",
      "--max-bytes", "100",
    ], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("main.js: 0.1 KB");
    expect(result.stdout).toContain("0.1 KB  src/main.ts");
  });
});
