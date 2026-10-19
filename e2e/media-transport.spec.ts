import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type W = Window & { app: { commands: { executeCommandById(id: string): void }; vault: { createBinary(path: string, bytes: ArrayBuffer): Promise<unknown> }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> } } };
const settings = { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } };
const isEndpoint = (r: import("@playwright/test").Request) => r.method() === "POST" && r.url().endsWith("/chat/completions");
async function openImage(page: import("@playwright/test").Page) {
  await page.evaluate(async png => {
    const app = (window as unknown as W).app;
    await app.vault.createBinary("ArchiveChart.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer);
    app.commands.executeCommandById("claude-companion:new-chat-tab");
  }, PNG);
  const chat = page.locator(".cc-chat-root"), input = chat.locator(".cc-input");
  await input.fill("@ArchiveChart"); await expect(chat.locator(".cc-at-item.is-selected")).toContainText("ArchiveChart"); await input.press("Enter");
  await input.fill("  Explain the chart I attached.  ");
  return { chat, input, models: chat.locator(".cc-ctl-model .cc-ctl-select") };
}

test("a text-only endpoint refuses media, preserves the draft, and allows an explicit provider switch", async ({ rig }, info) => {
  const { page } = await rig.reset({ endpointModels: ["e2e-local-model"], settingsOverride: settings, providerReply: [{ match: PNG, replies: ["Chart received."] }] });
  const errors: string[] = [], onError = (error: Error) => errors.push(error.message), posts: string[] = [];
  const onRequest = (r: import("@playwright/test").Request) => { if (isEndpoint(r)) posts.push(r.postData() || ""); };
  page.on("pageerror", onError); page.on("request", onRequest);
  try {
    const { chat, input, models } = await openImage(page);
    await expect(models.locator('option[value="custom:e2e-local-model"]')).toHaveCount(1);
    await models.selectOption("custom:e2e-local-model");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").filter({ hasText: "sends text only" }).last()).toBeVisible();
    await expect(input).toHaveValue("  Explain the chart I attached.  ");
    expect(posts).toEqual([]); expect(await rig.providerRequests()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as W).app.plugins.plugins["claude-companion"]!.conversations().getActive() === null)).toBe(true);
    await chat.locator(".cc-context-trigger").click();
    const context = chat.getByRole("dialog", { name: "Message context" });
    await expect(context).toContainText("ArchiveChart.png");
    await page.screenshot({ path: info.outputPath("unsupported-connection-keeps-question-and-image.png") });
    await context.getByRole("button", { name: "Close message context" }).click();
    await models.selectOption("e2e-model");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Chart received.");
    expect(await rig.providerRequests()).toBe(1); expect(posts).toEqual([]);
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill("Keep my next question.");
    await models.selectOption("custom:e2e-local-model");
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(page.locator(".notice").filter({ hasText: "sends text only" }).last()).toBeVisible();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Chart received.");
    await expect(input).toHaveValue("Keep my next question.");
    expect(await rig.providerRequests()).toBe(1); expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); page.off("request", onRequest); }
});

test("a failed image request does not fall back to a text-only endpoint and can retry with its image", async ({ rig }, info) => {
  const { page } = await rig.reset({ endpointModels: ["e2e-local-model"], settingsOverride: { ...settings, chatBackend: "auto", ollamaHost: "", openaiCompatModel: "e2e-local-model" }, providerFail: [{ match: PNG, status: 503 }] });
  const errors: string[] = [], onError = (error: Error) => errors.push(error.message), posts: string[] = [];
  const onRequest = (r: import("@playwright/test").Request) => { if (isEndpoint(r)) posts.push(r.postData() || ""); };
  page.on("pageerror", onError); page.on("request", onRequest);
  try {
    const { chat } = await openImage(page);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-error")).toBeVisible();
    await expect(chat).toContainText("Local fallback was skipped");
    expect(posts).toEqual([]);
    expect(await rig.providerRequests()).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => {
      const active = (window as unknown as W).app.plugins.plugins["claude-companion"]!.conversations().getActive();
      return active?.messages.filter(message => message.role === "user").at(-1)?.media?.some(item => item.label === "ArchiveChart.png") === true;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath("media-request-refuses-text-only-fallback.png") });
    await rig.control.setStubs({ providerReply: [{ match: PNG, replies: ["Retried with the chart."] }] });
    await chat.locator(".cc-error-retry").first().click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Retried with the chart.");
    expect(await rig.providerRequests()).toBe(1); expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  } finally { page.off("pageerror", onError); page.off("request", onRequest); }
});

test("a text-only question still reaches the selected local endpoint", async ({ rig }) => {
  const { page } = await rig.reset({ endpointModels: ["e2e-local-model"], endpointReply: "Local text reply.", settingsOverride: settings });
  await page.evaluate(() => { (window as unknown as W).app.commands.executeCommandById("claude-companion:new-chat-tab"); });
  const chat = page.locator(".cc-chat-root"), models = chat.locator(".cc-ctl-model .cc-ctl-select");
  await expect(models.locator('option[value="custom:e2e-local-model"]')).toHaveCount(1);
  await models.selectOption("custom:e2e-local-model");
  await chat.locator(".cc-input").fill("Summarize this question.");
  const request = page.waitForRequest(isEndpoint);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  expect((await request).postDataJSON()).toMatchObject({ messages: expect.arrayContaining([{ role: "user", content: "Summarize this question." }]) });
  await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Local text reply.");
  expect(await rig.providerRequests()).toBe(0);
});
