import { defineConfig } from "@playwright/test";

// README screenshot generation, run separately from the test suite against
// the same single rig: `pnpm run e2e:captures`.
export default defineConfig({
  testDir: "..",
  testMatch: "captures/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  globalSetup: "../globalSetup.ts",
  outputDir: process.env.CC_E2E_OUTPUT_DIR ?? "/private/tmp/claude-companion-research-e2e-results",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
