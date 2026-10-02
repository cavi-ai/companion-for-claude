// Verifies esbuild pass 1 produced a sane inlined embedding-worker artifact.
// Run AFTER `pnpm run build` (the file lives in .build/, which is generated).
// This used to be an in-suite assertion behind skipIf(!existsSync(...)), which
// never ran in CI because tests execute before the build. Wired into the CI
// verify job right after the bundle budget check.
import { readFile } from "node:fs/promises";
import process from "node:process";

const artifact = new URL("../.build/embed-worker.txt", import.meta.url);

let src;
try {
  src = await readFile(artifact, "utf8");
} catch (error) {
  console.error(`verify-worker-bundle: cannot read ${artifact.pathname} — run \`pnpm run build\` first.`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const failures = [];

const mainArg = process.argv.indexOf("--main");
const mainPath = mainArg === -1 ? new URL("../main.js", import.meta.url) : process.argv[mainArg + 1];
let mainSrc;
try {
  mainSrc = await readFile(mainPath, "utf8");
} catch (error) {
  console.error(`verify-worker-bundle: cannot read main.js — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// main.js must carry the workers gzipped: a raw slice of either artifact means it was inlined as text again.
for (const name of ["embed-worker", "pdf-worker"]) {
  const worker = name === "embed-worker" ? src : await readFile(new URL(`../.build/${name}.txt`, import.meta.url), "utf8");
  const marker = worker.slice('"use strict";'.length, '"use strict";'.length + 200);
  if (marker.length < 200) failures.push(`${name} artifact is too short to carry a 200-char marker`);
  else if (mainSrc.includes(marker)) failures.push(`main.js contains the raw ${name} text; it must be inlined gzipped`);
}

// transformers.js is inlined, not CDN-loaded — the bundle can't be tiny.
if (src.length <= 400_000) {
  failures.push(`worker artifact is ${src.length} bytes; expected > 400000 (transformers.js should be inlined)`);
}
// esbuild hoists the strict-mode pragma out of the bundled ESM in both prod
// (minified) and dev pass-1 outputs (verified empirically).
if (!src.startsWith('"use strict";')) {
  failures.push('worker artifact does not start with the esbuild "use strict"; pragma');
}
// esbuild must have lowered import.meta away: inside a Blob-URL iife worker a
// surviving import.meta.url is a runtime landmine.
if (src.includes("import.meta")) {
  failures.push("worker artifact still contains import.meta (a Blob-URL iife worker cannot resolve it)");
}

if (failures.length > 0) {
  console.error("verify-worker-bundle: FAILED");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`verify-worker-bundle: OK (${src.length} bytes)`);
