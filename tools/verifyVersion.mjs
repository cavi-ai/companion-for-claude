// Version lockstep gate: manifest, package, versions.json, and CHANGELOG must agree.
// Usage: node scripts/verifyVersion.mjs [expected-version]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoDir = dirname(pluginDir);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const manifest = read(join(pluginDir, "manifest.json"));
const pkg = read(join(pluginDir, "package.json"));
const versions = read(join(pluginDir, "versions.json"));
const changelog = readFileSync(join(repoDir, "CHANGELOG.md"), "utf8");

const version = manifest.version;
const errors = [];

const expected = process.argv[2];
if (expected && expected !== version) errors.push(`expected version ${expected} != manifest.json ${version}`);
if (pkg.version !== version) errors.push(`package.json ${pkg.version} != manifest.json ${version}`);
if (!(version in versions)) errors.push(`versions.json has no entry for ${version}`);
else if (versions[version] !== manifest.minAppVersion) errors.push(`versions.json["${version}"] ${versions[version]} != manifest.json minAppVersion ${manifest.minAppVersion}`);
if (!changelog.includes(`## [${version}]`)) errors.push(`CHANGELOG.md has no "## [${version}]" section`);

if (errors.length) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(`Version lockstep OK: ${version} (minAppVersion ${manifest.minAppVersion})`);
