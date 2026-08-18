#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PRODUCT_SLUG = "companion-for-claude";
// The artifact is cut from the development monorepo; the community-store
// mirror stays valid so either repository can publish during the move.
const RELEASE_REPOSITORIES = new Set(["cavi-ai/claude-obsidian", "cavi-ai/companion-for-claude"]);
// The monorepo namespaces its tags; the mirror tags the bare version.
const TAG_PREFIXES = ["", "obsidian-v"];
// cavi-home registers this slug as product-docs; envelope, manifest, and the
// registry entry must agree or its release ingest rejects the dispatch.
const PRODUCT_KIND = "product-docs";
// Registry artifactPathTemplate: docs/companion-for-claude/v{version}.
const DOCS_ROOT = (version) => `docs/${PRODUCT_SLUG}/v${version}`;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !["manifest", "envelope", "docs-root"].includes(command)) {
    fail("usage: cavi-release.mjs <manifest|envelope|docs-root> [options]");
  }

  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`invalid option near ${flag ?? "end of arguments"}`);
    }
    const key = flag.slice(2);
    if (key === "asset") {
      const assets = values.get(key) ?? [];
      assets.push(value);
      values.set(key, assets);
    } else if (values.has(key)) {
      fail(`duplicate option --${key}`);
    } else {
      values.set(key, value);
    }
  }
  return { command, values };
}

function exactOptions(values, required, repeated = []) {
  const allowed = new Set([...required, ...repeated]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) fail(`unknown option --${key}`);
  }
  for (const key of required) {
    if (!values.has(key)) fail(`missing option --${key}`);
  }
}

function commonSource(values) {
  const version = values.get("version");
  const tag = values.get("tag");
  const repository = values.get("repository");
  const commit = values.get("commit");
  if (!VERSION_RE.test(version)) fail(`invalid stable version: ${version}`);
  if (!TAG_PREFIXES.some((prefix) => tag === `${prefix}${version}`)) fail(`tag ${tag} does not name version ${version}`);
  if (!RELEASE_REPOSITORIES.has(repository)) fail(`unexpected repository: ${repository}`);
  if (!COMMIT_RE.test(commit)) fail(`invalid commit: ${commit}`);
  return { version, tag, repository, commit };
}

async function digestFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function buildManifest(values) {
  exactOptions(
    values,
    ["version", "tag", "repository", "commit", "source-date-epoch"],
    ["asset"],
  );
  const source = commonSource(values);
  const epoch = values.get("source-date-epoch");
  if (!/^\d+$/.test(epoch) || Number(epoch) <= 0) fail(`invalid source date epoch: ${epoch}`);

  const names = values.get("asset") ?? [];
  if (names.length === 0 || new Set(names).size !== names.length) {
    fail("at least one unique asset is required");
  }
  for (const name of names) {
    if (path.basename(name) !== name || name === "." || name === "..") {
      fail(`unsafe asset name: ${name}`);
    }
  }

  const assets = [];
  for (const name of [...names].sort()) {
    assets.push({ name, sha256: await digestFile(path.resolve(name)) });
  }
  // Identity keys are flat and must equal the envelope: cavi-home's
  // assertReleaseIdentity compares schemaVersion, slug, kind, version, tag,
  // repository, and commit key by key for every kind except package-docs.
  return {
    schemaVersion: 1,
    slug: PRODUCT_SLUG,
    kind: PRODUCT_KIND,
    version: source.version,
    tag: source.tag,
    repository: source.repository,
    commit: source.commit,
    assets,
    generatedAt: new Date(Number(epoch) * 1000).toISOString(),
  };
}

function buildEnvelope(values) {
  exactOptions(values, [
    "version", "tag", "repository", "commit", "artifact-url", "artifact-sha256",
  ]);
  const source = commonSource(values);
  const expectedUrl = `https://github.com/${source.repository}/releases/download/${source.tag}/` +
    `${PRODUCT_SLUG}-cavi-release-${source.version}.tar.gz`;
  const artifactUrl = values.get("artifact-url");
  const artifactSha256 = values.get("artifact-sha256");
  if (artifactUrl !== expectedUrl) fail(`unexpected artifact URL: ${artifactUrl}`);
  if (!SHA256_RE.test(artifactSha256)) fail("invalid artifact sha256");
  return {
    schemaVersion: 1,
    slug: PRODUCT_SLUG,
    kind: PRODUCT_KIND,
    version: source.version,
    tag: source.tag,
    repository: source.repository,
    commit: source.commit,
    artifact: { url: artifactUrl, sha256: artifactSha256, format: "tar.gz" },
  };
}

export { PRODUCT_KIND, DOCS_ROOT };

try {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "docs-root") {
    exactOptions(values, ["version"]);
    const version = values.get("version");
    if (!VERSION_RE.test(version)) fail(`invalid stable version: ${version}`);
    process.stdout.write(`${DOCS_ROOT(version)}\n`);
  } else {
    const result = command === "manifest" ? await buildManifest(values) : buildEnvelope(values);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`cavi-release: ${error.message}\n`);
  process.exitCode = 1;
}
