import { expect, test } from "./fixtures";

test("a fresh install connects with Enter and sends its first chat without a wizard", async ({ rig }) => {
  const harness = await rig.reset({ firstRun: true, providerReply: [{ match: "/./", replies: ["Connected", "First message received."] }] });
  try {
    const { page } = harness;
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    await expect(page.locator(".cc-setup-card")).toBeVisible();
    await page.locator(".cc-setup-input").fill("sk-ant-api-e2e");
    await page.locator(".cc-setup-input").press("Enter");
    await expect(page.locator(".cc-setup-card")).toHaveCount(0);
    expect(await harness.providerRequests()).toBe(1);
    for (const window of harness.windows()) await expect(window.locator(".modal-container")).toHaveCount(0);
    await page.locator(".cc-input").fill("Hello");
    await page.locator(".cc-input").evaluate((input) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(await harness.providerRequests()).toBe(1);
    await page.locator(".cc-input").press("Enter");
    await expect(page.locator(".cc-assistant .cc-body").last()).toContainText("First message received.");
    expect(await harness.providerRequests()).toBe(2);
    for (const window of harness.windows()) await expect(window.locator(".modal-container")).toHaveCount(0);
  } finally { await harness.close(); }
});
