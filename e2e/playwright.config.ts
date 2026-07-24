import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "research-desk.spec.ts",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  outputDir: process.env.CC_E2E_OUTPUT_DIR ?? "/private/tmp/claude-companion-research-e2e-results",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
