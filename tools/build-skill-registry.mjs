#!/usr/bin/env node
// Regenerates src/workflows/skillRegistry.generated.ts from the pinned claude-plugin submodule.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillEntries, renderRegistry } from "./skill-registry-lib.mjs";

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(plugin, "src", "workflows", "skillRegistry.generated.ts");
writeFileSync(out, renderRegistry(buildSkillEntries(path.join(path.dirname(plugin), "claude-plugin"))));
console.log(`wrote ${path.relative(plugin, out)}`);
