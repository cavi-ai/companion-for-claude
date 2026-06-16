import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      // Exercise modules that import the Obsidian API against an in-memory fake.
      obsidian: fileURLToPath(new URL("./test/fakes/obsidian.ts", import.meta.url)),
    },
  },
});
