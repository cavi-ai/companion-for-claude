// Verifies esbuild pass 1 produced a sane inlined embedding-worker artifact.
// Run AFTER `pnpm run build` (the file lives in .build/, which is generated).
// This used to be an in-suite assertion behind skipIf(!existsSync(...)), which
// never ran in CI because tests execute before the build. Wired into the CI
// verify job right after the bundle budget check.
import { readFile } from "node:fs/promises";

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
