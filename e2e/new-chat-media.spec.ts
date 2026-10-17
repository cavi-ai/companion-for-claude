import { expect, test } from "./fixtures";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";

for (const delayed of [false, true]) {
  test(`New chat excludes ${delayed ? "a late" : "a ready"} pasted image from its next request`, async ({ rig }) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
      providerReply: [
        { match: '/"type"\\s*:\\s*"image"/', replies: ["Image received."] },
        { match: "/./", replies: ["Text only."] },
      ],
    });
    await page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator("textarea");
    await input.fill("Review the pilot chart.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();

    const paste = async (wait: boolean, name: string) => input.evaluate((element, args) => {
      const bytes = Uint8Array.from(atob(args.png), (c) => c.charCodeAt(0));
      const file = new File([bytes], args.name, { type: "image/png" });
      if (args.wait) {
        const read = new Promise<ArrayBuffer>((resolve) => {
          (window as unknown as { finishMediaRead: () => void }).finishMediaRead = () => resolve(bytes.buffer);
        });
        Object.defineProperty(file, "arrayBuffer", { value: () => read });
      }
      const data = new DataTransfer();
      data.items.add(file);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { png: PNG, wait, name });

    await paste(delayed, "old-chart.png");
    if (!delayed) {
      await chat.getByRole("button", { name: /Manage context/ }).click();
      await expect(page.getByRole("dialog")).toContainText("old-chart.png");
      await page.keyboard.press("Escape");
    }
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    if (delayed) await page.evaluate(async () => {
      (window as unknown as { finishMediaRead: () => void }).finishMediaRead();
      await Promise.resolve();
    });
    await chat.getByRole("button", { name: /Manage context/ }).click();
    await expect(page.getByRole("dialog")).not.toContainText("old-chart.png");
    await page.keyboard.press("Escape");
    await input.fill("Start an unrelated discussion.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText(["Text only."]);
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();

    await paste(false, "new-chart.png");
    await chat.getByRole("button", { name: /Manage context/ }).click();
    await expect(page.getByRole("dialog")).toContainText("new-chart.png");
    await page.keyboard.press("Escape");
    await input.fill("Review this newly attached image.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Image received.");
    expect(await rig.providerRequests()).toBe(3);
  });
}
