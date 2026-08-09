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
      slug: "companion-for-claude",
      kind: "product-docs",
      version: "0.22.2",
      tag: "0.22.2",
      repository: "cavi-ai/companion-for-claude",
      commit: COMMIT,
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
      kind: "product-docs",
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

  // 2026-08-09: every release since 0.23.0 published fine and cavi-home's ingest
  // rejected all of them — "Envelope kind release-facts does not match package
  // product-docs" — so the site never picked up a Companion release. These are
  // the registry facts for this slug in cavi-ai/cavi-home content/releases/packages.json.
  it("matches the package cavi-home registers for this slug", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "companion-cavi-contract-"));
    for (const [name, contents] of Object.entries({ "main.js": "x\n", "manifest.json": "{}\n", "styles.css": "y\n" })) {
      await writeFile(path.join(root, name), contents);
    }
    const run = (command: string, extra: string[]) => spawnSync(process.execPath, [
      SCRIPT, command,
      "--version", "0.24.1",
      "--tag", "0.24.1",
      "--repository", "cavi-ai/companion-for-claude",
      "--commit", COMMIT,
      ...extra,
    ], { cwd: root, encoding: "utf8" });

    const manifest = run("manifest", ["--source-date-epoch", "1785778130", "--asset", "main.js"]);
    const envelope = run("envelope", [
      "--artifact-url", "https://github.com/cavi-ai/companion-for-claude/releases/download/0.24.1/companion-for-claude-cavi-release-0.24.1.tar.gz",
      "--artifact-sha256", "d".repeat(64),
    ]);
    expect(manifest.status, manifest.stderr).toBe(0);
    expect(envelope.status, envelope.stderr).toBe(0);
    const manifestBody = JSON.parse(manifest.stdout) as Record<string, unknown>;
    const envelopeBody = JSON.parse(envelope.stdout) as Record<string, unknown>;

    // The registered kind. A rename on either side breaks ingestion.
    expect(envelopeBody.kind).toBe("product-docs");
    // tagPrefix is "" for this package, so the tag is the bare version.
    expect(envelopeBody.tag).toBe(envelopeBody.version);
    // assertReleaseIdentity compares these key by key against the envelope.
    for (const key of ["schemaVersion", "slug", "kind", "version", "tag", "repository", "commit"]) {
      expect(manifestBody[key], `cavi-release.json ${key}`).toEqual(envelopeBody[key]);
    }
    // artifactPathTemplate: docs/companion-for-claude/v{version}.
    const docsRoot = spawnSync(process.execPath, [SCRIPT, "docs-root", "--version", "0.24.1"], { encoding: "utf8" });
    expect(docsRoot.status, docsRoot.stderr).toBe(0);
    expect(docsRoot.stdout.trim()).toBe("docs/companion-for-claude/v0.24.1");
  });
});
