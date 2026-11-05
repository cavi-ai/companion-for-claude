import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const [source, destination] = process.argv.slice(2);
if (!source || !destination || resolve(source) === resolve(destination)) throw new Error("Expected distinct source and destination directories.");
const names = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts", "esbuild.config.mjs", "eslint.config.mjs", "main.js", "manifest.json", "styles.css", "versions.json"];
// Read every required input before creating a partial release package.
const files = await Promise.all(names.map(async (name) => [name, await readFile(join(source, name))]));
await mkdir(destination, { recursive: true });
for (const [name, content] of files) await writeFile(join(destination, name), content);
