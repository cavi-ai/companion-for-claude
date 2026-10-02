// The worker bundle inlined gzipped (built by esbuild's first pass — see
// esbuild.config.mjs). Isolated in its own module so nothing test-imported
// ever resolves the .txt artifact.

import workerGz from "../../../.build/embed-worker.txt.gz";
import { inflateWorkerSource } from "../workerText";

let workerSource: string | null = null;

export function createEmbedWorker(): Worker {
  const url = URL.createObjectURL(new Blob([(workerSource ??= inflateWorkerSource(workerGz))], { type: "text/javascript" }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}
