import { dismissSettingsSurface, expect, openSettingsSection, test } from "./fixtures";
import type { ContentBlock } from "../src/providers/types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type AppWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  vault: { createBinary(path: string, bytes: ArrayBuffer): Promise<unknown> };
  plugins: { plugins: Record<string, { settings: { chatBackend: string } }> };
} };
type Payload = { messages: Array<{ role: string; content: string | ContentBlock[] }> };
const images = (request: Payload) => request.messages.flatMap(message => typeof message.content === "string" ? [] : message.content.filter(block => block.type === "image").map(block => block.source.data));

test("API Resume retains history after a CLI image conversation", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ claudeCli: true, fakeClaudeCode: true,
    settingsOverride: { apiKey: "e2e-key", context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
    providerDelayMs: 5000, providerReply: [{ match: "/./", replies: ["Delayed API reply."] }],
  });
  const errors: string[] = [];
  const requests: Payload[] = [];
  const onError = (error: Error) => errors.push(error.message);
  const onRequest = (request: import("@playwright/test").Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/messages")) requests.push(request.postDataJSON() as Payload);
  };
  page.on("pageerror", onError);
  page.on("request", onRequest);
  try {
    await page.evaluate(async png => {
      const app = (window as unknown as AppWindow).app;
      await app.vault.createBinary("Chart.png", Uint8Array.from(atob(png), character => character.charCodeAt(0)).buffer);
      await app.commands.executeCommandById("claude-companion:new-chat-tab");
    }, PNG);
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("@Chart");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Chart");
    await input.press("Enter");
    await input.fill("Describe the original chart.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("pong from claude code");
    const settings = await openSettingsSection(rig, "Provider & model");
    const row = settings.locator(".setting-item").filter({ has: settings.locator(".setting-item-name").getByText("Chat backend", { exact: true }) });
    await row.getByRole("combobox").selectOption("claude");
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.settings.chatBackend)).toBe("claude");
    await dismissSettingsSurface(settings);
    await input.fill("Compare that chart with the earlier discussion.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect.poll(() => requests.length).toBe(1);
    await chat.getByRole("button", { name: "Stop generating", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await rig.reloadPlugin();
    const resume = chat.locator(".cc-interrupted-turn").getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toBeVisible();
    expect(images(requests[0]!)).toEqual([PNG]);
    await rig.control.setStubs({ providerReply: [{ match: "/./", replies: ["Resumed API reply."] }] });
    await resume.click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Resumed API reply.");
    expect(requests).toHaveLength(2);
    expect(images(requests[1]!)).toEqual([PNG]);
    const body = JSON.stringify(requests[1]!.messages);
    expect(body).toContain("Describe the original chart.");
    expect(body).toContain("pong from claude code");
    expect(body).toContain("Compare that chart with the earlier discussion.");
    expect(errors).toEqual([]);
    await chat.screenshot({ path: testInfo.outputPath("api-resume-retains-cli-history.png") });
  } finally { page.off("pageerror", onError); page.off("request", onRequest); }
});
