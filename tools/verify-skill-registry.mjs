#!/usr/bin/env node
// Gate: the committed registry must equal a fresh generation. Skips when the submodule is absent.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillEntries, renderRegistry } from "./skill-registry-lib.mjs";

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(path.dirname(plugin), "claude-plugin", "capabilities.json");
if (!existsSync(source)) {
  console.log("claude-plugin submodule absent; skipping skill registry verification");
  process.exit(0);
}
const expected = renderRegistry(buildSkillEntries(path.dirname(source)));
const actual = readFileSync(path.join(plugin, "src", "workflows", "skillRegistry.generated.ts"), "utf8");
if (expected !== actual) {
  console.error("src/workflows/skillRegistry.generated.ts is stale — run `pnpm run skills:build`");
  process.exit(1);
}
console.log("skill registry is current");
