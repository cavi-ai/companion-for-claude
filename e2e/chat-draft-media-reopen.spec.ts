import { expect, test } from "./fixtures";

type TestWindow = Window & { app: { commands: { executeCommandById(id: string): void }; vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown> } } };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";

test("Undo close tab and reload retain a vault image attached to the draft", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    extraFiles: { "Notes/Seed.md": "# Seed" },
    providerReply: [{ match: PNG, replies: ["The draft image is restored."] }],
  });
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    const command = (id: string) => page.evaluate((value) => (window as unknown as TestWindow).app.commands.executeCommandById(value), id);
    await command("claude-companion:new-chat-tab");
    await page.evaluate(async (png) => {
      const data = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      await (window as unknown as TestWindow).app.vault.createBinary("Notes/DraftChart.png", data.buffer);
    }, PNG);
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("@DraftChart");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("DraftChart");
    await input.press("Enter");
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("Notes/DraftChart.png");
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("Explain this image.");
    await command("workspace:close");
    await expect(chat).toHaveCount(0);
    await command("workspace:undo-close-pane");
    await expect(input).toHaveValue("Explain this image.");
    await rig.reloadPlugin();
    await expect(input).toHaveValue("Explain this image.");
    await chat.locator(".cc-context-trigger").click();
    await expect(context).toContainText("Notes/DraftChart.png");
    await page.screenshot({ path: testInfo.outputPath("draft-image-restored-after-reload.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The draft image is restored.");
    expect(await rig.providerRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    page.off("pageerror", onError);
  }
});
