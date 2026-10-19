import { expect, test } from "./fixtures";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
test("Regenerate uses the resumed question rather than the other conversation image", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerReply: [
      { match: String.raw`/^(?=[\s\S]*ARCHIVE-A-REGEN-621)(?=[\s\S]*"type"\s*:\s*"image")/`, replies: ["Foreign image included."] },
      { match: String.raw`/^(?=[\s\S]*CHART-B-REGEN-622)(?=[\s\S]*"type"\s*:\s*"image")/`, replies: ["Image B received."] },
      { match: "/./", replies: ["Original A."] },
    ],
  });
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
  page.on("pageerror", onError);
  try {
    await page.evaluate(() => { (window as unknown as { app: { commands: { executeCommandById(id: string): void } } }).app.commands.executeCommandById("claude-companion:new-chat-tab"); });
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("ARCHIVE-A-REGEN-621");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original A.");
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    await input.evaluate((element, png) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "private-chart-b.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG);
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("private-chart-b.png");
    await context.getByRole("button", { name: "Close message context" }).click();
    await input.fill("CHART-B-REGEN-622");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Image B received.");
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
    await page.locator(".cc-session-row").filter({ hasText: "ARCHIVE-A-REGEN-621" }).click();
    await chat.locator(".cc-context-trigger").click();
    await expect(context).not.toContainText("private-chart-b.png");
    await page.screenshot({ path: testInfo.outputPath("resumed-text-question-with-no-image.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original A.");
    expect(await rig.providerRequests()).toBe(3);
    await page.screenshot({ path: testInfo.outputPath("regenerate-kept-the-text-question.png") });
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
    await page.locator(".cc-session-row").filter({ hasText: "CHART-B-REGEN-622" }).click();
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Image B received.");
    expect(await rig.providerRequests()).toBe(4);
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); }
});

for (const missing of [false, true]) {
  test(`Regenerate ${missing ? "refuses a missing" : "reopens the original"} vault image after reload and preserves a queued image`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
      providerReply: [{ match: "/./", replies: ["Original chart answer."] }],
    });
    await page.evaluate(async (png) => {
      const app = (window as unknown as { app: { vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown> }; commands: { executeCommandById(id: string): void } } }).app;
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      await app.vault.createBinary("ChartOriginal.png", bytes.buffer);
      await app.vault.createBinary("ChartQueued.png", new Uint8Array([...bytes, 0]).buffer);
      app.commands.executeCommandById("claude-companion:new-chat-tab");
    }, PNG);
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("@ChartOriginal");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("ChartOriginal");
    await input.press("Enter");
    await input.fill("Original chart question.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await rig.reloadPlugin();
    await input.fill("@ChartQueued");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("ChartQueued");
    await input.press("Enter");
    await input.fill("My next question.");
    const originalPattern = PNG.replaceAll("+", "[+]");
    const queuedPattern = Buffer.from([...Buffer.from(PNG, "base64"), 0]).toString("base64").replaceAll("+", "[+]");
    await rig.control.setStubs({ providerReply: [
      { match: String.raw`/^(?=[\s\S]*${originalPattern})(?![\s\S]*${queuedPattern})/`, replies: ["Original image only."] },
      { match: String.raw`/^(?=[\s\S]*${queuedPattern})(?=[\s\S]*${originalPattern})/`, replies: ["Queued image with original history."] },
      { match: "/./", replies: ["Wrong image selection."] },
    ] });
    if (missing) await page.evaluate(async () => {
      const vault = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown; delete(file: unknown): Promise<void> } } }).app.vault;
      await vault.delete(vault.getAbstractFileByPath("ChartOriginal.png"));
    });
    const before = await rig.providerRequests();
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    if (missing) {
      await expect(page.locator(".notice").filter({ hasText: "Couldn't attach ChartOriginal" })).toBeVisible();
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original chart answer.");
      expect(await rig.providerRequests()).toBe(before);
    } else {
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Original image only.");
      expect(await rig.providerRequests()).toBe(before + 1);
    }
    await expect(input).toHaveValue("My next question.");
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("ChartQueued.png");
    await expect(context).not.toContainText("ChartOriginal.png");
    await page.screenshot({ path: testInfo.outputPath("next-question-keeps-its-queued-image.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    if (missing) {
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await expect(page.locator(".notice").filter({ hasText: "Earlier attachment ChartOriginal.png" }).last()).toBeVisible();
      await expect(input).toHaveValue("My next question.");
      expect(await rig.providerRequests()).toBe(before);
      await page.evaluate(async png => {
        await (window as unknown as { app: { vault: { createBinary(path: string, bytes: ArrayBuffer): Promise<unknown> } } }).app.vault.createBinary("ChartOriginal.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer);
      }, PNG);
    }
    const sent = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/messages"));
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    const payload = (await sent).postDataJSON() as { messages: Array<{ content: unknown }> };
    expect(payload.messages[0]?.content).toMatchObject([{ type: "image", source: { data: PNG } }, { type: "text", text: "Original chart question." }]);
    const queued = Buffer.from([...Buffer.from(PNG, "base64"), 0]).toString("base64");
    expect(payload.messages.at(-1)?.content).toMatchObject([{ type: "image", source: { data: queued } }, { type: "text", text: "My next question." }]);
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Queued image with original history.");
  });
}

test("Regenerate refuses an expired pasted reference without dropping the saved answer", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerReply: [{ match: "/./", replies: ["Unexpected request."] }],
  });
  // Persist an accepted question whose ephemeral image bytes are no longer live.
  await page.evaluate(async () => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, import("../src/main").default> } } }).app.plugins.plugins["claude-companion"]!;
    const user = { role: "user" as const, content: "Review the pasted chart.", media: [{ label: "pasted-chart.png", kind: "image" as const, mime: "image/png" }] };
    const turn = await plugin.conversations().beginTurn(null, [user], { backend: "claude", model: "e2e-model", mode: "ask" });
    await plugin.conversations().completeTurn(turn.conversationId, turn.turnId, [user, { role: "assistant", content: "Saved image answer." }]);
  });
  await rig.reloadPlugin();
  await page.evaluate(() => { (window as unknown as { app: { commands: { executeCommandById(id: string): void } } }).app.commands.executeCommandById("claude-companion:open-chat"); });
  const chat = page.locator(".cc-chat-root");
  await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Saved image answer.");
  const before = await rig.providerRequests();
  await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.locator(".notice").filter({ hasText: "Paste it again and resend the question" })).toBeVisible();
  expect(await rig.providerRequests()).toBe(before);
  await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Saved image answer.");
});
