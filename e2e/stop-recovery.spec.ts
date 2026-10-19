import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  workspace: { getLeavesOfType(type: string): Array<{ detach(): void }> };
} };

for (const reopen of [false, true]) {
  test(`Stop offers Resume without reloading${reopen ? " in a reopened running conversation" : ""}`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ settingsOverride: { agentModeEnabled: false }, providerDelayMs: 15000,
      providerReply: [{ match: "/./", replies: ["Delayed reply."] }],
    });
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    try {
      await page.evaluate(async () => { await (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:new-chat-tab"); });
      const chat = page.locator(".cc-chat-root"), input = chat.locator(".cc-input");
      await input.fill("Summarize the archive notes.");
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await expect.poll(() => rig.providerRequests()).toBe(1);
      if (reopen) {
        await page.evaluate(async () => {
          const app = (window as unknown as AppWindow).app;
          for (const leaf of app.workspace.getLeavesOfType("claude-companion-chat")) leaf.detach();
          await app.commands.executeCommandById("claude-companion:open-chat");
        });
      }
      await chat.getByRole("button", { name: "Stop generating", exact: true }).click();
      await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      const row = chat.locator(".cc-interrupted-turn");
      await expect(row.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await expect(row).toHaveCount(1);
      await input.fill("Keep my follow-up question.");
      await chat.screenshot({ path: testInfo.outputPath("stop-offers-resume.png") });
      await rig.control.setStubs({ providerReply: [{ match: "/Summarize the archive notes/", replies: ["Resumed the archive task."] }, { match: "/./", replies: ["Original task missing."] }] });
      await row.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Resumed the archive task.");
      await expect(row).toHaveCount(0);
      await expect(input).toHaveValue("Keep my follow-up question.");
      expect(errors).toEqual([]);
    } finally { page.off("pageerror", onError); }
  });
}
