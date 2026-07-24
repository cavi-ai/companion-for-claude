// The worker bundle inlined as text (built by esbuild's first pass — see
// esbuild.config.mjs). Isolated in its own module so nothing test-imported
// ever resolves the .txt artifact.

import workerSource from "../../../.build/embed-worker.txt";

export function createEmbedWorker(): Worker {
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}
