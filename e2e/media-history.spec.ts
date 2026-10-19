import { expect, test } from "./fixtures";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type W = Window & { finishHistoryRead?(): void; restoreHistoryRead?(): void; historyReadStarted?: boolean; app: { commands: { executeCommandById(id: string): void }; vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown>; getAbstractFileByPath(path: string): unknown; delete(file: unknown): Promise<void>; readBinary(file: { path: string }): Promise<ArrayBuffer> } } };
const settings = { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } };
const messageRequest = (r: import("@playwright/test").Request) => r.method() === "POST" && r.url().endsWith("/messages");
async function imageConversation(rig: import("./fixtures").Rig, endpoint = false) {
  const { page } = await rig.reset({ ...(endpoint ? { endpointModels: ["e2e-local-model"] } : {}), settingsOverride: settings, providerReply: [{ match: PNG, replies: ["History image received."] }, { match: "/./", replies: ["Image missing."] }] });
  await page.evaluate(async png => { const app = (window as unknown as W).app; await app.vault.createBinary("ArchiveChart.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer); app.commands.executeCommandById("claude-companion:new-chat-tab"); }, PNG);
  const chat = page.locator(".cc-chat-root"), input = chat.locator(".cc-input");
  await input.fill("@ArchiveChart"); await expect(chat.locator(".cc-at-item.is-selected")).toContainText("ArchiveChart"); await input.press("Enter");
  await input.fill("Explain the archive chart.");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("History image received.");
  await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
  return { page, chat, input };
}
async function assertEarlierImage(request: import("@playwright/test").Request) {
  const payload = request.postDataJSON() as { messages: Array<{ role: string; content: unknown }> };
  expect(payload.messages[0]).toMatchObject({ role: "user", content: [{ type: "image", source: { data: PNG } }, { type: "text", text: "Explain the archive chart." }] });
}

test("follow-ups and regeneration retain the earlier image after plugin reload", async ({ rig }, info) => {
  const { page, chat, input } = await imageConversation(rig);
  const errors: string[] = [], onError = (error: Error) => errors.push(error.message); page.on("pageerror", onError);
  try {
    for (const reload of [false, true]) {
      if (reload) await rig.reloadPlugin();
      await input.fill(reload ? "Follow-up after reload: describe the top-left corner." : "Follow-up: describe the top-left corner.");
      const sent = page.waitForRequest(messageRequest);
      await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
      await assertEarlierImage(await sent);
      await expect(chat.locator(".cc-assistant .cc-body")).toHaveCount(reload ? 3 : 2);
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("History image received.");
    }
    const regenerated = page.waitForRequest(messageRequest);
    await chat.getByRole("button", { name: "Regenerate", exact: true }).last().click();
    await assertEarlierImage(await regenerated);
    await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("History image received.");
    expect(await rig.providerRequests()).toBe(4);
    await page.screenshot({ path: info.outputPath("earlier-image-retained-through-follow-up-and-reload.png") });
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); }
});

test("an unavailable historical image refuses a follow-up and allows restoring the file", async ({ rig }, info) => {
  const { page, chat, input } = await imageConversation(rig);
  await page.evaluate(async () => { const vault = (window as unknown as W).app.vault; await vault.delete(vault.getAbstractFileByPath("ArchiveChart.png")); });
  await input.fill("  What is in the corner?  ");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(page.locator(".notice").filter({ hasText: "Earlier attachment ArchiveChart.png" }).last()).toBeVisible();
  await expect(input).toHaveValue("  What is in the corner?  ");
  expect(await rig.providerRequests()).toBe(1);
  await expect(chat.locator(".cc-user")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("unavailable-earlier-image-keeps-follow-up-unsent.png") });
  await page.evaluate(async png => { await (window as unknown as W).app.vault.createBinary("ArchiveChart.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer); }, PNG);
  const sent = page.waitForRequest(messageRequest);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await assertEarlierImage(await sent);
  await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("History image received.");
  expect(await rig.providerRequests()).toBe(2);
});

test("switching to a text-only endpoint cannot silently drop an earlier image", async ({ rig }, info) => {
  const { page, chat, input } = await imageConversation(rig, true);
  const posts: string[] = [], onRequest = (r: import("@playwright/test").Request) => { if (r.url().endsWith("/chat/completions") && r.method() === "POST") posts.push(r.postData() || ""); };
  page.on("request", onRequest);
  try {
    const models = chat.locator(".cc-ctl-model .cc-ctl-select");
    await expect(models.locator('option[value="custom:e2e-local-model"]')).toHaveCount(1); await models.selectOption("custom:e2e-local-model");
    await input.fill("Follow-up: what does the chart label mean?");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").filter({ hasText: "sends text only" }).last()).toBeVisible();
    await expect(input).toHaveValue("Follow-up: what does the chart label mean?");
    expect(posts).toEqual([]); expect(await rig.providerRequests()).toBe(1);
    await page.screenshot({ path: info.outputPath("local-switch-keeps-historical-image-question-unsent.png") });
    await models.selectOption("e2e-model");
    const sent = page.waitForRequest(messageRequest);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click(); await assertEarlierImage(await sent);
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("History image received.");
    expect(posts).toEqual([]); expect(await rig.providerRequests()).toBe(2);
  } finally { page.off("request", onRequest); }
});

for (const fail of [false, true]) test(`navigating away while historical media preparation ${fail ? "rejects" : "completes"} preserves the new draft`, async ({ rig }) => {
  const { page, chat, input } = await imageConversation(rig);
  await page.evaluate(failed => {
    const win = window as unknown as W, vault = win.app.vault, original = vault.readBinary;
    win.historyReadStarted = false;
    const gate = new Promise<void>(resolve => { win.finishHistoryRead = resolve; });
    win.restoreHistoryRead = () => { vault.readBinary = original; };
    vault.readBinary = async file => { if (file.path === "ArchiveChart.png") { win.historyReadStarted = true; await gate; if (failed) throw new Error("Old image read failed"); } return original.call(vault, file); };
  }, fail);
  try {
    await input.fill("Keep this follow-up with the chart.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as W).historyReadStarted)).toBe(true);
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    await input.fill("A different unsent question.");
    await page.evaluate(async () => { (window as unknown as W).finishHistoryRead?.(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(await page.locator(".notice").filter({ hasText: "Earlier attachment" }).count()).toBe(0);
    await expect(input).toHaveValue("A different unsent question.");
    expect(await rig.providerRequests()).toBe(1);
    await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
    await page.locator(".cc-session-row").filter({ hasText: "Explain the archive chart" }).click();
    await expect(input).toHaveValue("Keep this follow-up with the chart.");
    await page.evaluate(() => { (window as unknown as W).restoreHistoryRead?.(); });
    const sent = page.waitForRequest(messageRequest);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click(); await assertEarlierImage(await sent);
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("History image received.");
    expect(await rig.providerRequests()).toBe(2);
  } finally { await page.evaluate(() => { const win = window as unknown as W; win.finishHistoryRead?.(); win.restoreHistoryRead?.(); }); }
});
