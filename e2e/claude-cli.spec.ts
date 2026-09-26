import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("chat runs on the Claude Code backend with no API key and reuses the process across sends", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root").first();
    await expect(chat).toBeVisible();
    await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
    const input = chat.locator(".cc-input").first();
    await input.fill("ping");
    await input.press("Enter");
    await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
    await input.fill("ping again");
    await input.press("Enter");
    await expect(chat.locator(".cc-msg.cc-assistant")).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code");

    const log = await readFile(harness.argvLog, "utf8");
    const argvLines = log.split("\n").filter((l) => l.startsWith("ARGV "));
    const stdinLines = log.split("\n").filter((l) => l.startsWith("STDIN "));
    expect(argvLines).toHaveLength(1);
    expect(stdinLines).toHaveLength(2);
    expect(argvLines[0]).toContain("--strict-mcp-config");
    expect(argvLines[0]).toContain("--setting-sources");
    expect(argvLines[0]).toContain("--session-id");
    expect(argvLines[0]).not.toContain("--bare");
    expect(argvLines[0]).not.toContain("mcp__obsidian-vault__*");
    expect(await harness.providerRequests()).toBe(0);

    // The minted --session-id is persisted with the conversation so memory import can skip it.
    const dataPath = join(harness.paths.vault, ".obsidian", "plugins", "claude-companion", "data.json");
    await expect.poll(async () => /"cliSessionId":\s*"[0-9a-f-]{36}"/.test(await readFile(dataPath, "utf8").catch(() => "")), { timeout: 10_000 }).toBe(true);
  } finally {
    await harness.close();
  }
});

test("a failed Claude Code result shows an error, not an empty reply", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root").first();
    await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
    const input = chat.locator(".cc-input").first();
    await input.fill("please make it fail");
    await input.press("Enter");
    const error = chat.locator(".cc-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("selected model");
  } finally {
    await harness.close();
  }
});

test("a skill from the palette runs as a composed turn on the Claude Code backend", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root").first();
    await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
    const input = chat.locator(".cc-input").first();
    await input.fill("/wikilink-weaver Build plan.md");
    await input.press("Enter");
    await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
    await expect(chat.locator(".cc-msg.cc-user").last()).toContainText("/wikilink-weaver Build plan.md");

    const log = await readFile(harness.argvLog, "utf8");
    const stdin = log.split("\n").filter((l) => l.startsWith("STDIN "));
    expect(stdin).toHaveLength(1);
    expect(stdin[0]).toContain("Wikilink weaver");
    expect(stdin[0]).toContain("# Task");
    expect(stdin[0]).toContain("Build plan.md");
    expect(stdin[0]).not.toContain("REQUIRED SUB-SKILL");
  } finally {
    await harness.close();
  }
});

test("an unresponsive Claude Code turn survives restart and resumes explicitly", async ({ rig }) => {
  const harness = await rig.reset({ claudeCli: true });
  const dataPath = join(harness.paths.vault, ".obsidian", "plugins", "claude-companion", "data.json");
  await harness.page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = harness.page.locator(".cc-chat-root").first();
  await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
  await chat.locator(".cc-input").fill("hang forever");
  await chat.locator(".cc-input").press("Enter");
  await expect.poll(async () => {
    const data = await readFile(dataPath, "utf8").catch(() => "");
    return data.includes("hang forever") && /"activeTurn"\s*:\s*\{/.test(data) && /"state"\s*:\s*"running"/.test(data);
  }, { timeout: 10_000 }).toBe(true);

  // "Restart" = disable → enable the plugin in place: onunload() closes the
  // in-flight CLI session (SIGTERM, then SIGKILL after the grace period), and
  // the freshly onload()ed plugin discovers the interrupted turn from data.json
  // exactly as it would after Obsidian itself restarted.
  await harness.reloadPlugin();
  await harness.page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const reopened = harness.page.locator(".cc-chat-root").first();
  await expect(reopened).toContainText("hang forever");
  await expect(reopened).toContainText("This task was interrupted");
  await reopened.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(reopened.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
  await expect.poll(async () => /"activeTurn"\s*:/.test(await readFile(dataPath, "utf8").catch(() => "")), { timeout: 10_000 }).toBe(false);
  const log = await readFile(harness.argvLog, "utf8");
  expect(log.split("\n").filter((line) => line.startsWith("ARGV ")).at(-1)).toContain("--resume");
});
