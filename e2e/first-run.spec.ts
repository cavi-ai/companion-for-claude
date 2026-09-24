import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { launchObsidianHarness } from "./obsidianHarness";

/**
 * How many deferred-consent prompts are open across the whole app. Accepting
 * Obsidian's trust prompt can leave an auxiliary Settings window in front, and
 * Obsidian mounts the modal there — so counting only the vault window both
 * misses a real prompt and would not catch a duplicate.
 */
const deferredPrompts = async (harness: { windows(): import("@playwright/test").Page[] }): Promise<number> => {
  const counts = await Promise.all(harness.windows().map((w) => w.getByRole("button", { name: "Not now" }).count().catch(() => 0)));
  return counts.reduce((total, count) => total + count, 0);
};

const openModals = async (harness: { windows(): import("@playwright/test").Page[] }): Promise<number> => {
  const counts = await Promise.all(harness.windows().map((w) => w.locator(".modal-container").count().catch(() => 0)));
  return counts.reduce((total, count) => total + count, 0);
};

const openChat = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
};

// The legacy one-shot desktop-integrations prompt the wizard's vault-tools
// step replaces — proving it, singular, never appears.
const offerLocators = (harness: { windows(): import("@playwright/test").Page[] }) =>
  harness.windows().map((w) => w.locator(".modal-container").filter({ hasText: "Set up desktop integrations" }));

const offerVisible = async (harness: { windows(): import("@playwright/test").Page[] }): Promise<boolean> => {
  const counts = await Promise.all(offerLocators(harness).map((l) => l.count().catch(() => 0)));
  return counts.some((n) => n > 0);
};

const wizardLocators = (harness: { windows(): import("@playwright/test").Page[] }) =>
  harness.windows().map((w) => w.locator(".modal-container").filter({ hasText: "Set up Claude Companion" }));

const wizardVisible = async (harness: { windows(): import("@playwright/test").Page[] }): Promise<boolean> => {
  const counts = await Promise.all(wizardLocators(harness).map((l) => l.count().catch(() => 0)));
  return counts.some((n) => n > 0);
};

// The wizard modal, in whichever window Obsidian has focused.
const wizardWindow = async (harness: { windows(): import("@playwright/test").Page[] }): Promise<import("@playwright/test").Locator> => {
  for (const locator of wizardLocators(harness)) {
    if ((await locator.count().catch(() => 0)) > 0) return locator;
  }
  throw new Error("setup wizard modal not found in any window");
};

// Fresh-install ordering is one user journey and therefore one app launch.
test("a fresh install orders credential, consent, and desktop integration setup", async () => {
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
    expect(await deferredPrompts(harness)).toBe(0);
    expect(await openModals(harness)).toBe(0);

    // Sending without a credential flags the card instead of failing a request.
    const composer = page.locator(".cc-input");
    await composer.fill("does this send?");
    await composer.press("Enter");
    await expect(page.locator(".cc-setup-card")).toBeVisible();
    expect(harness.providerRequests()).toBe(0);

    await page.locator(".cc-setup-input").fill("sk-ant-api-e2e");
    await page.locator(".cc-setup-save").click();

    // One verification request goes out before the card is dismissed.
    await expect.poll(() => harness.providerRequests()).toBeGreaterThan(0);
    await expect(page.locator(".cc-setup-card")).toHaveCount(0);

    // The remaining wizard steps now open — exactly one modal, in whichever
    // window Obsidian has focused — starting on Vault tools (Connect is
    // already satisfied; the legacy one-shot offer never fires).
    await expect.poll(() => wizardVisible(harness), { timeout: 10_000 }).toBe(true);
    expect(await openModals(harness)).toBe(1);
    expect(await offerVisible(harness)).toBe(false);
    const wizard = await wizardWindow(harness);
    await expect(wizard).toContainText("Vault tools");

    // Walk the wizard to the end without opening the real desktop-integrations
    // flow (its own "Connect vault tools to Claude Code" action).
    await wizard.getByRole("button", { name: "Skip" }).click();
    await expect(wizard).toContainText("Index your vault");
    await wizard.getByRole("button", { name: "Finish" }).click();

    await expect.poll(() => wizardVisible(harness), { timeout: 10_000 }).toBe(false);
    expect(await offerVisible(harness)).toBe(false);

    const dataPath = join(harness.paths.vault, ".obsidian", "plugins", "claude-companion", "data.json");
    await expect.poll(async () => (JSON.parse(await readFile(dataPath, "utf8")) as { settings: { desktopIntegrationsOffered?: boolean } }).settings.desktopIntegrationsOffered, { timeout: 10_000 }).toBe(true);
  } finally {
    await harness.close();
  }
});
