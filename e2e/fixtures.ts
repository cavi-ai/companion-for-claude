import { expect, test as base } from "@playwright/test";
import { shutdownSharedObsidianHarness } from "./obsidianHarness";

export const test = base.extend<{}, { sharedObsidianLifecycle: void }>({
  sharedObsidianLifecycle: [async ({}, use) => {
    await use(undefined);
    await shutdownSharedObsidianHarness();
  }, { auto: true, scope: "worker" }],
});

export { expect };
