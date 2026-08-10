#!/usr/bin/env node
// Gate lane: build the docs artifact from the current guides and verify it
// against the contract, so a guide that breaks ingest fails before release.
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const tools = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.dirname(tools);
const repo = path.dirname(plugin);
const require = createRequire(import.meta.url);
const { version } = require(path.join(plugin, "manifest.json"));

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const epoch = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const out = await mkdtemp(path.join(tmpdir(), "companion-docs-"));

const built = execFileSync(process.execPath, [
  path.join(tools, "build-docs-artifact.mjs"),
  "--version", version,
  "--tag", version,
  "--commit", commit,
  "--guides", path.join(repo, "guides"),
  "--readme", path.join(plugin, "README.md"),
  "--out", out,
  "--source-date-epoch", epoch,
], { encoding: "utf8" }).trim();

execFileSync(process.execPath, [path.join(tools, "verify-docs-artifact.mjs"), path.join(out, built)], { stdio: "inherit" });
