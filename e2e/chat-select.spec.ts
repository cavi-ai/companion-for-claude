import { expect, test } from "./fixtures";

test("an assistant reply's text can be selected with the mouse", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root").first();
    await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
    await chat.locator(".cc-input").fill("ping");
    await chat.locator(".cc-input").press("Enter");
    const reply = chat.locator(".cc-msg.cc-assistant").last();
    await expect(reply).toContainText("pong from claude code", { timeout: 30_000 });

    // The transcript re-renders when the turn settles; select once it is stable.
    await expect(async () => {
      const box = await reply.getByText("pong from claude code").boundingBox();
      if (!box) throw new Error("reply text has no box");
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("from claude code");
    }).toPass({ timeout: 10_000 });
  } finally {
    await harness.close();
  }
});
