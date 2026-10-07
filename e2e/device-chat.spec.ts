import { expect, test } from "./fixtures";

test("device backend exposes its download controls and fails closed without cached weights", async ({ rig }) => {
  const harness = await rig.reset({ settingsOverride: { chatBackend: "device", deviceChatModel: "smollm2-360m", apiKey: "", agentModeEnabled: false } });
  const page = harness.page;
  const settings = await harness.openSettings();
  const tab = settings.locator(".vertical-tab-content-container .vertical-tab-content").last();
  await expect(tab.getByText("On-device model", { exact: true })).toBeVisible();
  await expect(tab.getByRole("button", { name: "Download model", exact: true })).toBeVisible();
  await expect(tab.getByRole("button", { name: "Delete model", exact: true })).toBeVisible();
  if (!settings.isClosed()) await settings.keyboard.press("Escape").catch(() => undefined);
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root").first();
  await expect(chat.locator(".cc-backend-pill")).toContainText("On-device GPU");
  await expect(chat.locator(".cc-model").first()).toContainText("SmolLM2 360M · on-device");
  await expect(chat.locator(".cc-ctl-model .cc-ctl-select")).toHaveValue("device:smollm2-360m");
  await chat.locator(".cc-input").fill("Say hello.");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText(/Download|WebGPU|float16|cache/i, { timeout: 20_000 });
  expect(await harness.providerRequests()).toBe(0);
  await page.screenshot({ path: test.info().outputPath("device-chat.png") });
});
