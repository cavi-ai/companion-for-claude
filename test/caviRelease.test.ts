import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("tools/cavi-release.mjs");
const COMMIT = "c".repeat(40);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// The release repo asserts its own workflow contract; .github/ is never mirrored.
describe("CAVI release facts", () => {
  it("derives a strict manifest and envelope from immutable plugin assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "companion-cavi-release-"));
    const assets = {
      "main.js": "console.log('companion');\n",
      "manifest.json": '{"id":"claude-companion","version":"0.22.2"}\n',
      "styles.css": ".companion { display: block; }\n",
    };
    for (const [name, contents] of Object.entries(assets)) {
      await writeFile(path.join(root, name), contents);
    }

    const manifest = spawnSync(process.execPath, [
      SCRIPT,
      "manifest",
      "--version", "0.22.2",
      "--tag", "0.22.2",
      "--repository", "cavi-ai/companion-for-claude",
      "--commit", COMMIT,
      "--source-date-epoch", "1785778130",
      "--asset", "main.js",
      "--asset", "manifest.json",
      "--asset", "styles.css",
    ], { cwd: root, encoding: "utf8" });
    expect(manifest.status, manifest.stderr).toBe(0);
    expect(JSON.parse(manifest.stdout)).toEqual({
      schemaVersion: 1,
      product: { slug: "companion-for-claude", version: "0.22.2" },
      source: {
        repository: "cavi-ai/companion-for-claude",
        tag: "0.22.2",
        commit: COMMIT,
      },
      assets: [
        { name: "main.js", sha256: sha256(assets["main.js"]) },
        { name: "manifest.json", sha256: sha256(assets["manifest.json"]) },
        { name: "styles.css", sha256: sha256(assets["styles.css"]) },
      ],
      generatedAt: "2026-08-03T17:28:50.000Z",
    });

    const envelope = spawnSync(process.execPath, [
      SCRIPT,
      "envelope",
      "--version", "0.22.2",
      "--tag", "0.22.2",
      "--repository", "cavi-ai/companion-for-claude",
      "--commit", COMMIT,
      "--artifact-url",
      "https://github.com/cavi-ai/companion-for-claude/releases/download/0.22.2/companion-for-claude-cavi-release-0.22.2.tar.gz",
      "--artifact-sha256", "d".repeat(64),
    ], { cwd: root, encoding: "utf8" });
    expect(envelope.status, envelope.stderr).toBe(0);
    expect(JSON.parse(envelope.stdout)).toEqual({
      schemaVersion: 1,
      slug: "companion-for-claude",
      kind: "release-facts",
      version: "0.22.2",
      tag: "0.22.2",
      repository: "cavi-ai/companion-for-claude",
      commit: COMMIT,
      artifact: {
        url: "https://github.com/cavi-ai/companion-for-claude/releases/download/0.22.2/companion-for-claude-cavi-release-0.22.2.tar.gz",
        sha256: "d".repeat(64),
        format: "tar.gz",
      },
    });
  });

});
