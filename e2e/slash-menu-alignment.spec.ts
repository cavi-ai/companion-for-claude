import { expect, test } from "./fixtures";

test("slash commands align at the left and keep extended commands searchable", async ({ rig }) => {
  const harness = await rig.reset();
  try {
    await harness.page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = harness.page.locator(".cc-chat-root");
    const input = chat.locator("textarea");
    await input.fill("/");
    const menu = chat.locator(".cc-slash-menu:not(.cc-at-menu)");
    await expect(menu).toBeVisible();
    const names = menu.locator(".cc-slash-name");
    const positions = await names.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
    expect(positions.length).toBeGreaterThan(5);
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
    await expect(menu.getByRole("button", { name: /\/manifest-vault/i })).toHaveCount(0);

    await input.fill("/manifest-vault");
    await expect(menu.getByRole("button", { name: /\/manifest-vault/i })).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("mouse clicks select without submitting and Enter explicitly runs the command", async ({ rig }) => {
  const { page } = await rig.reset();
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
  });
  const input = page.locator(".cc-chat-root textarea");
  await input.fill("/brainstorm");
  const menu = page.locator(".cc-slash-menu:not(.cc-at-menu)");
  await menu.locator(".cc-slash-item").click();
  await expect(menu).toBeVisible();
  await expect(input).toHaveValue("/brainstorm");
  expect(await rig.providerRequests()).toBe(0);
  await input.press("Tab");
  await expect(input).toHaveValue("/brainstorm");
  await input.fill("/brainstorm");
  await input.press("Enter");
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue("Brainstorm strong, concrete ideas for: ");
});

test("native touch scrolling and selection keep slash commands open until Run", async ({ rig }) => {
  const harness = await rig.reset();
  const { page } = harness;
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const input = page.locator(".cc-chat-root textarea");
    await input.fill("/");
    const list = page.locator(".cc-slash-menu:not(.cc-at-menu) .cc-slash-list");
    await list.evaluate((el) => { el.style.maxHeight = "150px"; });
    const box = (await list.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height - 20;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 15 }] });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator(".cc-slash-menu:not(.cc-at-menu)")).toBeVisible();
    await expect(input).toHaveValue("/");
    expect(await rig.providerRequests()).toBe(0);

    await input.fill("/brainstorm");
    const option = page.locator(".cc-slash-item").filter({ has: page.locator(".cc-slash-name", { hasText: /^\/brainstorm$/ }) });
    const target = (await option.boundingBox())!;
    const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator(".cc-slash-menu:not(.cc-at-menu)")).toBeVisible();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    await expect(input).toHaveValue("/brainstorm");
    expect(await rig.providerRequests()).toBe(0);
    await page.screenshot({ path: test.info().outputPath("slash-selection.png") });
    const run = page.getByRole("button", { name: "Run selected command" });
    const runBox = (await run.boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: runBox.x + runBox.width / 2, y: runBox.y + runBox.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator(".cc-slash-menu:not(.cc-at-menu)")).toBeHidden();
    await expect(input).toHaveValue("Brainstorm strong, concrete ideas for: ");
  } finally {
    await cdp.detach();
    await harness.close();
  }
});
