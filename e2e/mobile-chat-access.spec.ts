import { expect, test } from "./fixtures";
import { launchObsidianHarness, type ObsidianHarness } from "./obsidianHarness";

test.describe.configure({ mode: "serial" });

let harness: ObsidianHarness;

test.beforeAll(async () => {
  harness = await launchObsidianHarness();
  await harness.page.setViewportSize({ width: 320, height: 900 });
  await harness.page.evaluate(async () => {
    // The desktop harness cannot replace Obsidian's module-scoped Platform
    // singleton. Its native mobile layout class still exercises the responsive
    // surface; activation routing itself is covered by chatActivation.test.ts.
    document.body.classList.add("is-mobile");
    const rightSplit = document.querySelector<HTMLElement>(".workspace-split.mod-right-split");
    if (!rightSplit) throw new Error("Right sidebar is missing");
    rightSplit.style.setProperty("display", "flex", "important");
    rightSplit.style.setProperty("position", "fixed", "important");
    rightSplit.style.setProperty("inset", "0", "important");
    rightSplit.style.setProperty("width", "100vw", "important");
    rightSplit.style.setProperty("min-width", "0", "important");
    rightSplit.style.setProperty("z-index", "100", "important");
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  await expect(harness.page.locator(".cc-chat-root")).toBeVisible();
});

test.afterAll(async () => { await harness?.close(); });

async function expectChatFits(width: number): Promise<void> {
  const { page } = harness;
  await page.setViewportSize({ width, height: 900 });
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator("textarea");
  await input.fill("/research");
  const menu = chat.locator(".cc-slash-menu:not(.cc-at-menu)");
  const option = menu.getByRole("button", { name: /\/research/i });
  await expect(menu).toBeVisible();
  await expect(option).toBeVisible();
  for (const selector of [".cc-messages", ".cc-composer"]) {
    const region = chat.locator(selector);
    await expect.poll(async () => await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await expect.poll(async () => await menu.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const [chatBox, inputBox, sendBox] = await Promise.all([chat.boundingBox(), input.boundingBox(), chat.getByRole("button", { name: "Send" }).boundingBox()]);
  expect(chatBox && inputBox && sendBox).toBeTruthy();
  for (const control of [inputBox!, sendBox!]) {
    expect(control.x).toBeGreaterThanOrEqual(chatBox!.x);
    expect(control.x + control.width).toBeLessThanOrEqual(chatBox!.x + chatBox!.width + 1);
    expect(control.y + control.height).toBeLessThanOrEqual(chatBox!.y + chatBox!.height + 1);
  }
}

test("mobile chat stays contained and opens Research Desk from a touch slash selection", async () => {
  const chat = harness.page.locator(".cc-chat-root");
  await harness.page.evaluate(() => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { activity: { start(input: { id: string; kind: string; title: string; total: number }): void } }> } } }).app.plugins.plugins["claude-companion"];
    plugin.activity.start({ id: "mobile-header", kind: "semantic-index", title: "Building semantic index", total: 5 });
  });
  await harness.page.setViewportSize({ width: 320, height: 900 });
  const header = chat.locator(".cc-header");
  await expect(header).toBeVisible();
  const activity = header.locator(".cc-activity-indicator");
  await expect(activity).toHaveAttribute("aria-label", "Companion activity: Building semantic index, 0%");
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(activity.locator("[role=progressbar]")).toHaveAttribute("aria-valuenow", "0");
  await expect(header.locator("[role=status]")).toHaveAttribute("aria-live", "polite");
  const activityBox = await activity.boundingBox();
  expect(activityBox).toBeTruthy();
  expect(activityBox!.width).toBe(44);
  expect(activityBox!.height).toBe(44);

  for (const width of [320, 360, 390, 428, 768]) await expectChatFits(width);

  const research = chat.locator(".cc-slash-menu:not(.cc-at-menu)").getByRole("button", { name: /\/research/i });
  await research.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await expect(harness.page.locator(".cc-research-desk")).toBeVisible();
});
