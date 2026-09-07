// Prints the largest inputs of main.js from .build/meta.json (pnpm run build first).
// Pass --check to fail when the generated bundle exceeds the release budget.
import { readFile } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 3_600_000;
const args = process.argv.slice(2);
let metaPath = new URL("../.build/meta.json", import.meta.url);
let maxBytes = DEFAULT_MAX_BYTES;
let check = false;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--check") {
    check = true;
    continue;
  }
  if (argument === "--meta" || argument === "--max-bytes") {
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--meta") metaPath = value;
    else {
      maxBytes = Number(value);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`invalid --max-bytes: ${value}`);
    }
    continue;
  }
  throw new Error(`unknown argument: ${argument}`);
}

const meta = JSON.parse(await readFile(metaPath, "utf8"));
const output = Object.entries(meta.outputs).find(([name]) => name.endsWith("main.js"));
if (!output) throw new Error("main.js is not in the metafile");
const [, info] = output;
const rows = Object.entries(info.inputs).map(([file, { bytesInOutput }]) => [file, bytesInOutput]).sort((a, b) => b[1] - a[1]).slice(0, 15);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`main.js: ${kb(info.bytes)}`);
for (const [file, bytes] of rows) console.log(`${kb(bytes).padStart(10)}  ${file}`);

if (check && info.bytes > maxBytes) {
  const over = info.bytes - maxBytes;
  console.error(`main.js exceeds the ${maxBytes} byte bundle budget by ${over} ${over === 1 ? "byte" : "bytes"}`);
  process.exitCode = 1;
}
