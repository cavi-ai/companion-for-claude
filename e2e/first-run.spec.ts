import { expect, test } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

const openChat = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
};

// A fresh install has no credential and stock onboarding defaults — the path the
// rest of the suite seeds past.
test("a fresh install asks for a credential before anything else", async () => {
  const harness = await launchObsidianHarness({ firstRun: true });
  const { page } = harness;
  try {
    await openChat(page);

    const card = page.locator(".cc-setup-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Connect to Claude");

    // The ontology-seed and embedding-download consents are one-shot; firing
    // them before the user can chat spends the only prompt they get. Same
    // locator the second spec proves does match once they are released.
    await expect(page.getByRole("button", { name: "Not now" })).toHaveCount(0);
    await expect(page.locator(".modal-container")).toHaveCount(0);

    // Sending without a credential flags the card instead of failing a request.
    const composer = page.locator(".cc-input");
    await composer.fill("does this send?");
    await composer.press("Enter");
    await expect(page.locator(".cc-setup-card")).toBeVisible();
    expect(harness.providerRequests()).toBe(0);
  } finally {
    await harness.close();
  }
});

test("saving a key verifies it, then releases the deferred prompts", async () => {
  const harness = await launchObsidianHarness({ firstRun: true });
  const { page } = harness;
  try {
    await openChat(page);
    await expect(page.locator(".cc-setup-card")).toBeVisible();

    await page.locator(".cc-setup-input").fill("sk-ant-api-e2e");
    await page.locator(".cc-setup-save").click();

    // One verification request goes out before the card is dismissed.
    await expect.poll(() => harness.providerRequests()).toBeGreaterThan(0);
    await expect(page.locator(".cc-setup-card")).toHaveCount(0);

    // Held-back consent now runs, one modal at a time.
    const deferred = page.getByRole("button", { name: "Not now" });
    await expect(deferred.first()).toBeVisible({ timeout: 10_000 });
    await expect(deferred).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
