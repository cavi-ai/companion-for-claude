import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // README screenshot generation is not a test; it runs separately against the
  // same rig via `pnpm run e2e:captures`.
  testIgnore: "captures/**",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  globalSetup: "./globalSetup.ts",
  outputDir: process.env.CC_E2E_OUTPUT_DIR ?? "/private/tmp/claude-companion-research-e2e-results",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
