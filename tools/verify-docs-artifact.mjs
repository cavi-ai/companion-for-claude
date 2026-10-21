#!/usr/bin/env node
// Enforces the docs artifact contract locally, so a break fails here instead of
// in cavi-home's ingest after the release is already published.
// Contract: cavi-ai/cavi-home docs/adding-docs-products.md.
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { checkMarkdownLinks } from "./docs-links.mjs";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: verify-docs-artifact.mjs <artifact-dir>\n");
  process.exit(1);
}

// Same tag policy as cavi-release.mjs and build-docs-artifact.mjs: the monorepo
// namespaces its tags, the community-store mirror tags the bare version.
const TAG_PREFIXES = ["", "obsidian-v"];
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

async function walk(dir, prefix = "") {
  const out = [];
  for (const entry of (await readdir(dir)).sort()) {
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if ((await stat(full)).isDirectory()) out.push(...(await walk(full, rel)));
    else out.push(rel);
  }
  return out;
}

const files = await walk(root);
check(files.includes("manifest.json"), "missing manifest.json");
check(files.includes("navigation.json"), "missing navigation.json");
if (errors.length) {
  for (const error of errors) process.stderr.write(`::error::${error}\n`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const navigation = JSON.parse(await readFile(path.join(root, "navigation.json"), "utf8"));

for (const key of ["schemaVersion", "package", "version", "contentSha256", "release"]) {
  check(manifest[key] !== undefined, `manifest.json missing ${key}`);
}
check(manifest.package === "companion-for-claude", `manifest.package ${manifest.package} is not companion-for-claude`);
check(typeof manifest.release?.tag === "string" && typeof manifest.release?.commit === "string", "manifest.release needs tag and commit");
check(
  TAG_PREFIXES.some((prefix) => manifest.release?.tag === `${prefix}${manifest.version}`),
  `manifest.release.tag ${manifest.release?.tag} does not name version ${manifest.version}`,
);
check(navigation.version === manifest.version, `navigation.version ${navigation.version} must equal manifest version ${manifest.version}`);
check(Array.isArray(navigation.sections) && navigation.sections.length > 0, "navigation.sections must not be empty");

// Every navigation target exists.
const targets = (navigation.sections ?? []).flatMap((section) => (section.pages ?? []).map((page) => page.path));
for (const target of targets) check(files.includes(target), `navigation target missing from the artifact: ${target}`);

errors.push(...await checkMarkdownLinks(root, files.filter((name) => name.endsWith(".md"))));

// contentSha256 hashes every file except manifest.json, lexically, as path NUL bytes NUL.
const hash = createHash("sha256");
for (const file of files.filter((name) => name !== "manifest.json")) {
  hash.update(file);
  hash.update(Buffer.from([0]));
  hash.update(await readFile(path.join(root, file)));
  hash.update(Buffer.from([0]));
}
const digest = hash.digest("hex");
check(digest === manifest.contentSha256, `contentSha256 ${manifest.contentSha256} does not match the artifact digest ${digest}`);

if (errors.length) {
  for (const error of errors) process.stderr.write(`::error::${error}\n`);
  process.exit(1);
}
process.stdout.write(`docs artifact OK: ${manifest.package} ${manifest.version} (${files.length} files)\n`);
