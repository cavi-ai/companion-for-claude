// Vitest runs in the `node` environment (no DOM). The plugin source uses the
// popout-window-safe globals Obsidian provides at runtime (`window`,
// `activeWindow`, `activeDocument`) and loads desktop-only Node builtins through
// the Electron `window.require`. Map those onto the node globals so the
// desktop code paths are exercisable in tests.
import { createRequire } from "node:module";

const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.activeWindow ??= globalThis;
g.activeDocument ??= (globalThis as { document?: unknown }).document ?? {};
if (typeof (globalThis as { require?: unknown }).require !== "function") {
  g.require = createRequire(import.meta.url);
}
