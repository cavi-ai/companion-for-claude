#!/usr/bin/env node
// Builds the docs artifact cavi-home ingests: manifest.json, navigation.json,
// and the guide pages, under docs/<slug>/v<version>/.
// Contract: cavi-ai/cavi-home docs/adding-docs-products.md.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SLUG = "companion-for-claude";
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

// Section order is the reading order of the guides; anything unlisted lands in Reference.
const SECTIONS = [
  { title: "Introduction", pages: ["index", "getting-started"] },
  { title: "Guides", pages: ["agent-mode", "artifacts", "research-workbench", "local-models", "auth", "claude-code-bridge"] },
];

function fail(message) {
  process.stderr.write(`build-docs-artifact: ${message}\n`);
  process.exit(1);
}

function titleOf(slugName, body) {
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim();
  return slugName.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]?.replace(/^--/, ""), process.argv[i + 1]);
const version = args.get("version");
const tag = args.get("tag");
const commit = args.get("commit");
const guidesDir = args.get("guides");
const readme = args.get("readme");
const outRoot = args.get("out");
const epoch = args.get("source-date-epoch");
if (!VERSION_RE.test(version ?? "")) fail(`invalid version: ${version}`);
if (tag !== version) fail(`tag ${tag} must equal version ${version}`);
if (!COMMIT_RE.test(commit ?? "")) fail(`invalid commit: ${commit}`);
if (!guidesDir || !readme || !outRoot) fail("missing --guides, --readme, or --out");
if (!/^\d+$/.test(epoch ?? "")) fail(`invalid source date epoch: ${epoch}`);

const destination = path.join(outRoot, "docs", SLUG, `v${version}`);
await mkdir(destination, { recursive: true });

// index.md is the README; every guide keeps its own filename.
const pages = new Map();
const sources = new Map();
pages.set("index.md", await readFile(readme, "utf8"));
sources.set("index.md", readme);
for (const entry of (await readdir(guidesDir)).sort()) {
  if (entry.endsWith(".md")) {
    pages.set(entry, await readFile(path.join(guidesDir, entry), "utf8"));
    sources.set(entry, path.join(guidesDir, entry));
  }
}

// The artifact must be self-contained: a relative target that isn't a shipped
// page becomes an absolute repository URL at this commit.
const repoRoot = path.resolve(guidesDir, "..");
const blobBase = `https://github.com/cavi-ai/claude-obsidian/blob/${commit}`;
for (const [file, body] of pages) {
  const from = path.dirname(sources.get(file));
  pages.set(file, body.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (whole, open, target, close) => {
    if (/^(https?:|mailto:|#|obsidian:)/.test(target)) return whole;
    const [pathPart, hash = ""] = target.split(/(?=#)/);
    if (pathPart === "") return whole;
    const resolved = path.resolve(from, pathPart);
    const shipped = path.basename(resolved);
    if (pages.has(shipped) && path.dirname(resolved) === path.resolve(guidesDir)) {
      return `${open}${shipped}${hash}${close}`;
    }
    return `${open}${blobBase}/${path.relative(repoRoot, resolved)}${hash}${close}`;
  }));
}

const listed = new Set(SECTIONS.flatMap((section) => section.pages.map((name) => `${name}.md`)));
const sections = SECTIONS.map((section) => ({
  title: section.title,
  pages: section.pages
    .map((name) => `${name}.md`)
    .filter((file) => pages.has(file))
    .map((file) => ({ title: titleOf(file.replace(/\.md$/, ""), pages.get(file)), path: file })),
})).filter((section) => section.pages.length > 0);
const rest = [...pages.keys()].filter((file) => !listed.has(file)).sort();
if (rest.length > 0) {
  sections.push({
    title: "Reference",
    pages: rest.map((file) => ({ title: titleOf(file.replace(/\.md$/, ""), pages.get(file)), path: file })),
  });
}

const navigation = { title: "Companion for Claude", version, sections };
for (const [file, body] of pages) await writeFile(path.join(destination, file), body);
await writeFile(path.join(destination, "navigation.json"), `${JSON.stringify(navigation, null, 2)}\n`);

// contentSha256 hashes every artifact file except manifest.json, in lexical
// path order, as path, NUL, bytes, NUL.
const hash = createHash("sha256");
for (const file of [...pages.keys(), "navigation.json"].sort()) {
  hash.update(file);
  hash.update(Buffer.from([0]));
  hash.update(await readFile(path.join(destination, file)));
  hash.update(Buffer.from([0]));
}

const manifest = {
  schemaVersion: 1,
  package: SLUG,
  product: SLUG,
  version,
  contentSha256: hash.digest("hex"),
  publicBasePath: `/docs/${SLUG}/v${version}`,
  stableAlias: `/docs/${SLUG}`,
  release: { tag, commit },
  generatedAt: new Date(Number(epoch) * 1000).toISOString(),
};
await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${path.relative(outRoot, destination)}\n`);
