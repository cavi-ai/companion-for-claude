// Obsidian runs on Electron, which exposes Node's `process` inside Web Workers.
// @huggingface/transformers decides between onnxruntime-web (WASM) and the
// native onnxruntime-node at import time from `process.release.name === "node"`.
// In this worker that check is true, so it picks onnxruntime-node — whose
// InferenceSession has no bundled native binding here, so the first model load
// crashes with "Cannot read properties of undefined (reading 'create')" and the
// whole built-in embedding engine is dead on desktop.
//
// This module is imported BEFORE "@huggingface/transformers" (ESM evaluates
// side-effect imports in source order), and neutralizes the Node signal for
// THIS worker's global only — Obsidian's main thread is untouched — so
// transformers takes the onnxruntime-web WASM path everywhere (desktop + mobile).

// `self` is the worker global (there is no `window` in a Worker). Matches the
// cast used in worker.ts; avoids the obsidianmd no-global-this rule too.
const g = self as unknown as {
  process?: { release?: { name?: string } };
};

try {
  if (g.process?.release?.name === "node") {
    Object.defineProperty(g.process, "release", {
      value: { ...g.process.release, name: "obsidian-worker" },
      configurable: true,
      writable: true,
    });
  }
} catch {
  // If `process.release` can't be redefined, leave it — worst case is the
  // pre-existing behavior, and mobile (no Node) already takes the web path.
}

export {};
