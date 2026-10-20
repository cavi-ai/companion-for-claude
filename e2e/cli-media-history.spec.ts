import { dismissSettingsSurface, expect, openSettingsSection, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import type { ContentBlock } from "../src/providers/types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type AppWindow = { app: { commands: { executeCommandById(id: string): Promise<void> }; vault: { createBinary(path: string, bytes: ArrayBuffer): Promise<unknown> }; plugins: { plugins: Record<string, { settings: { chatBackend: string } }> } } };
type Input = { message: { role: string; content: ContentBlock[] } };
const imageData = (input: Input) => input.message.content.filter(block => block.type === "image").map(block => block.source.data);
const text = (input: Input) => input.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");

for (const reload of [false, true]) {
  test(`switching an image conversation to Claude Code keeps its earlier image${reload ? " after reload" : ""}`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ fakeClaudeCode: true, settingsOverride: { context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } }, providerReply: [
      { match: String.raw`/^(?=[\s\S]*${PNG.replaceAll("+", "[+]")})/`, replies: ["API received the chart."] },
      { match: "/./", replies: ["API missing image."] },
    ] });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(async (png) => {
      const app = (window as unknown as AppWindow).app;
      await app.vault.createBinary("Chart.png", Uint8Array.from(atob(png), character => character.charCodeAt(0)).buffer);
      await app.commands.executeCommandById("claude-companion:new-chat-tab");
    }, PNG);
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("@Chart");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Chart");
    await input.press("Enter");
    await input.fill("Describe the chart for my archive.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("API received the chart.");
    if (reload) await rig.reloadPlugin();
    const settings = await openSettingsSection(rig, "Provider & model");
    const backend = settings.locator(".setting-item").filter({ has: settings.locator(".setting-item-name").getByText("Chat backend", { exact: true }) });
    await backend.getByRole("combobox").selectOption("claude-cli");
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.settings.chatBackend)).toBe("claude-cli");
    await dismissSettingsSurface(settings);
    await expect(chat.locator(".cc-backend-pill")).toContainText("Claude Code");
    await input.fill("Which part of that chart matters most?");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("pong from claude code");
    const log = await readFile(rig.argvLog, "utf8");
    const sent = log.split("\n").filter(line => line.startsWith("STDIN ")).map(line => JSON.parse(line.slice(6)) as Input);
    expect(sent.length).toBe(1);
    expect(imageData(sent[0]!)).toEqual([PNG]);
    expect(text(sent[0]!)).toContain("Describe the chart for my archive.");
    const boundary = sent[0]!.message.content.findIndex(block => block.type === "text" && block.text === "Newest user message:");
    expect(boundary).toBeGreaterThan(sent[0]!.message.content.findIndex(block => block.type === "image"));
    expect(text(sent[0]!)).toContain("Which part of that chart matters most?");
    expect(log.split("\n").filter(line => line.startsWith("ARGV ")).length).toBe(1);
    expect(log.split("\n").find(line => line.startsWith("ARGV "))?.includes("--resume")).toBe(false);
    await chat.screenshot({ path: testInfo.outputPath("image-conversation-continues-on-claude-code.png") });
    await input.fill("Explain one further detail of that chart.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveCount(3);
    const finalLog = await readFile(rig.argvLog, "utf8");
    const finalInputs = finalLog.split("\n").filter(line => line.startsWith("STDIN ")).map(line => JSON.parse(line.slice(6)) as Input);
    expect(finalInputs.length).toBe(2);
    expect(imageData(finalInputs[1]!)).toEqual([]);
    expect(text(finalInputs[1]!)).toContain("Explain one further detail of that chart.");
    expect(text(finalInputs[1]!)).not.toContain("Describe the chart for my archive.");
    expect(finalLog.split("\n").filter(line => line.startsWith("ARGV ")).length).toBe(1);
    expect(await rig.providerRequests()).toBe(1);
    expect(errors).toEqual([]);
  });
}
