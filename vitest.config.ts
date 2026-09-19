import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    globals: false,
    // The full suite performs several dynamic-import integration tests. Capping
    // workers avoids CPU contention that made their 5s assertions flaky in CI.
    maxWorkers: 2,
    // A cold dynamic import of src/main can exceed the 5s default on a loaded host.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts"],
      // Generated/registry data and the vendored worker shims aren't meaningful
      // coverage targets; everything else in src is.
      exclude: ["src/**/*.generated.ts", "src/typings/**"],
      // Ratchet floors set just below the current baseline (71/66/68/73%) so a
      // regression fails CI without churning on incidental fluctuations. Raise
      // these as coverage improves.
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 67,
        lines: 72,
      },
    },
  },
  resolve: {
    alias: {
      // Exercise modules that import the Obsidian API against an in-memory fake.
      obsidian: fileURLToPath(new URL("./test/fakes/obsidian.ts", import.meta.url)),
    },
  },
});
