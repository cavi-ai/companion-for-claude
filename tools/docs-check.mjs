#!/usr/bin/env node
// Gate lane: build the docs artifact from the current guides and verify it
// against the contract, so a guide that breaks ingest fails before release.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { checkMarkdownLinks } from "./docs-links.mjs";
import { prepareReleaseDocs } from "./prepare-release-docs.mjs";

const tools = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.dirname(tools);
const standalone = existsSync(path.join(plugin, "guides"));
const repo = standalone ? plugin : path.dirname(plugin);
const require = createRequire(import.meta.url);
const { version } = require(path.join(plugin, "manifest.json"));

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const epoch = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const out = await mkdtemp(path.join(tmpdir(), "companion-docs-"));

async function verifyArtifact(sourceRoot, readme, destination, repositoryRoots) {
  const built = execFileSync(process.execPath, [
    path.join(tools, "build-docs-artifact.mjs"),
    "--version", version, "--tag", version, "--commit", commit,
    "--guides", path.join(sourceRoot, "guides"), "--readme", readme,
    "--out", destination, "--source-date-epoch", epoch,
  ], { encoding: "utf8" }).trim();
  const artifact = path.join(destination, built);
  execFileSync(process.execPath, [path.join(tools, "verify-docs-artifact.mjs"), artifact], { stdio: "inherit" });
  const pages = [];
  for (const dir of ["introduction", "guides"]) {
    for (const file of await readdir(path.join(artifact, dir))) if (file.endsWith(".md")) pages.push(`${dir}/${file}`);
  }
  return checkMarkdownLinks(artifact, pages, repositoryRoots);
}

try {
  const files = ["README.md", ...(await readdir(path.join(repo, "guides"))).filter((file) => file.endsWith(".md")).map((file) => `guides/${file}`)];
  if (!standalone) files.push("obsidian-plugin/README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "native-ios/README.md");
  const repositoryRoots = { [standalone ? "cavi-ai/companion-for-claude" : "cavi-ai/claude-obsidian"]: repo };
  const errors = await checkMarkdownLinks(repo, files, repositoryRoots);
  if (!standalone) {
    const mirror = path.join(out, "mirror");
    const mirrored = await prepareReleaseDocs(repo, mirror, commit);
    repositoryRoots["cavi-ai/companion-for-claude"] = mirror;
    errors.push(...await checkMarkdownLinks(mirror, mirrored, repositoryRoots));
    errors.push(...await verifyArtifact(mirror, path.join(mirror, "README.md"), path.join(out, "mirror-artifact"), repositoryRoots));
  }
  errors.push(...await verifyArtifact(repo, path.join(plugin, "README.md"), path.join(out, "source-artifact"), repositoryRoots));
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(`documentation links OK: ${files.length} source pages${standalone ? "" : ", release mirror"}, website artifacts\n`);
} finally {
  await rm(out, { recursive: true, force: true });
}
