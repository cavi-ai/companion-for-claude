import { dismissSettingsSurface, expect, openSettingsSection, test, type Rig } from "./fixtures";
import { readFile } from "node:fs/promises";
import type { ContentBlock } from "../src/providers/types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type AppWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  vault: { createBinary(path: string, bytes: ArrayBuffer): Promise<unknown>; getAbstractFileByPath(path: string): unknown; delete(file: unknown): Promise<void> };
  plugins: { plugins: Record<string, { settings: { chatBackend: string } }> };
} };
type Input = { message: { content: ContentBlock[] } };
const text = (input: Input) => input.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
async function switchBackend(rig: Rig, value: string) {
  const settings = await openSettingsSection(rig, "Provider & model");
  const row = settings.locator(".setting-item").filter({ has: settings.locator(".setting-item-name").getByText("Chat backend", { exact: true }) });
  await row.getByRole("combobox").selectOption(value);
  await expect.poll(() => rig.page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.settings.chatBackend)).toBe(value);
  await dismissSettingsSurface(settings);
}

for (const action of ["accepted", "selection", "refused"] as const) {
  test(`returning to CLI ${action === "accepted" ? "includes accepted API context" : `preserves its session after ${action === "selection" ? "a Settings-only switch" : "a refused API send"}`}`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ claudeCli: true, fakeClaudeCode: true, extraFiles: { "Notes/Refused source.md": "A source that becomes unavailable." }, settingsOverride: { apiKey: "e2e-key", context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } }, providerReply: [
      { match: String.raw`/^(?=[\s\S]*${PNG.replaceAll("+", "[+]")})/`, replies: ["API received the intervening chart."] },
      { match: "/./", replies: ["API missing chart."] },
    ] });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(async png => {
      const app = (window as unknown as AppWindow).app;
      await app.vault.createBinary("Chart.png", Uint8Array.from(atob(png), character => character.charCodeAt(0)).buffer);
      await app.commands.executeCommandById("claude-companion:new-chat-tab");
    }, PNG);
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    const send = () => chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-backend-pill")).toContainText("Claude Code");
    await input.fill("Start the archive discussion.");
    await send();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("pong from claude code");
    await switchBackend(rig, "claude");
    if (action === "accepted") {
      await input.fill("@Chart");
      await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Chart");
      await input.press("Enter");
      await input.fill("Use the chart added during the API turn.");
      await send();
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("API received the intervening chart.");
    } else if (action === "refused") {
      await input.fill("@Refused");
      await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Refused source");
      await input.press("Enter");
      await page.evaluate(async () => { const vault = (window as unknown as AppWindow).app.vault; await vault.delete(vault.getAbstractFileByPath("Notes/Refused source.md")); });
      await input.fill("Do not send without the selected source.");
      await send();
      await expect.poll(async () => (await Promise.all(rig.windows().map(window => window.locator(".notice:visible").allTextContents()))).flat().join("\n")).toContain("Couldn't attach Notes/Refused source.md");
      await expect(input).toHaveValue("Do not send without the selected source.");
      await expect(chat.locator(".cc-user")).toHaveCount(1);
      expect(await rig.providerRequests()).toBe(0);
      await chat.locator(".cc-context-trigger").click();
      const context = chat.getByRole("dialog", { name: "Message context" });
      await context.getByRole("button", { name: "Remove Refused source", exact: true }).click();
      await context.getByRole("button", { name: "Close message context", exact: true }).click();
    }
    await switchBackend(rig, "claude-cli");
    const question = action === "accepted" ? "Now explain the chart we just discussed." : "Continue the archive discussion.";
    await input.fill(question);
    await send();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveCount(action === "accepted" ? 3 : 2);
    await expect(chat.getByRole("button", { name: /^Send(?: message)?$/ })).toBeVisible();
    const log = await readFile(rig.argvLog, "utf8");
    const argv = log.split("\n").filter(line => line.startsWith("ARGV "));
    const sent = log.split("\n").filter(line => line.startsWith("STDIN ")).map(line => JSON.parse(line.slice(6)) as Input);
    expect(argv.length).toBe(action === "accepted" ? 2 : 1);
    expect(sent.length).toBe(2);
    expect(argv.some(line => line.includes("--resume"))).toBe(false);
    expect(text(sent[1]!)).toContain(question);
    const media = sent[1]!.message.content.filter(block => block.type === "image").map(block => block.source.data);
    expect(media).toEqual(action === "accepted" ? [PNG] : []);
    if (action === "accepted") {
      expect(text(sent[1]!)).toContain("Use the chart added during the API turn.");
      expect(text(sent[1]!)).toContain("API received the intervening chart.");
      expect(text(sent[1]!)).toContain("Start the archive discussion.");
      expect(text(sent[1]!)).toContain("do not repeat earlier actions");
    } else expect(text(sent[1]!)).not.toContain("Start the archive discussion.");
    expect(await rig.providerRequests()).toBe(action === "accepted" ? 1 : 0);
    expect(errors).toEqual([]);
    await chat.screenshot({ path: testInfo.outputPath("return-to-cli-retains-conversation-context.png") });
  });
}
