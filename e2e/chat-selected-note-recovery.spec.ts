import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";

const BODY = "SELECTED-NOTE-CONTENT-573";
const OFF = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
type Gate = { entered: boolean; release?(): void; restore(): void };
type TestWindow = Window & {
  app: {
    commands: { executeCommandById(id: string): void };
    vault: {
      getAbstractFileByPath(path: string): unknown;
      delete(file: unknown, force?: boolean): Promise<void>;
      createFolder(path: string): Promise<unknown>;
      create(path: string, content: string): Promise<unknown>;
      cachedRead(file: { path: string }): Promise<string>;
    };
    plugins: { plugins: Record<string, ClaudeCompanionPlugin> };
  };
  restoreNoteRead?(): void;
  noteGate?: Gate;
};

for (const folder of [false, true]) {
  test(`a deleted selected ${folder ? "folder" : "note"} retains the question until restored`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: OFF },
      extraFiles: { "Notes/Selected.md": BODY },
      providerReply: [{ match: BODY, replies: ["The source arrived."] }],
    });
    await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-chat"));
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill(folder ? "@Notes/" : "@Selected");
    if (folder) {
      for (let step = 0; step < 12; step++) {
        if (await chat.locator(".cc-at-item.is-selected .cc-slash-name").textContent() === "Notes/") break;
        await input.press("ArrowDown");
      }
      await expect(chat.locator(".cc-at-item.is-selected .cc-slash-name")).toHaveText("Notes/");
      await input.press("Enter");
    }
    else {
      await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Selected");
      await input.press("Enter");
    }
    await input.fill("  Summarize my selected source.  ");
    await page.evaluate(async (isFolder) => {
      const app = (window as unknown as TestWindow).app;
      await app.vault.delete(app.vault.getAbstractFileByPath(isFolder ? "Notes" : "Notes/Selected.md"), true);
    }, folder);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").filter({ hasText: "Request not sent" })).toContainText("Reattach");
    await expect(input).toHaveValue("  Summarize my selected source.  ");
    expect(await rig.providerRequests()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("missing-source-question-retained.png") });
    await page.evaluate(async ({ isFolder, body }) => {
      const app = (window as unknown as TestWindow).app;
      if (isFolder) await app.vault.createFolder("Notes");
      await app.vault.create("Notes/Selected.md", body);
    }, { isFolder: folder, body: BODY });
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The source arrived.");
    expect(await rig.providerRequests()).toBe(1);
  });
}

test("a failed selected-note read retains the question and can be retried", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: OFF },
    extraFiles: { "Selected.md": BODY },
    providerReply: [{ match: BODY, replies: ["The readable source arrived."] }],
  });
  await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-chat"));
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator(".cc-input");
  await input.fill("@Selected");
  await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Selected");
  await input.press("Enter");
  await input.fill("Read this selected note.");
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    const vault = win.app.vault;
    const original = vault.cachedRead;
    win.restoreNoteRead = () => { vault.cachedRead = original; };
    vault.cachedRead = (file) => file.path === "Selected.md" ? Promise.reject(new Error("Selected note is not readable.")) : original.call(vault, file);
  });
  try {
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").filter({ hasText: "Request not sent" })).toContainText("not readable");
    await expect(input).toHaveValue("Read this selected note.");
    expect(await rig.providerRequests()).toBe(0);
    await page.evaluate(() => { (window as unknown as TestWindow).restoreNoteRead?.(); });
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The readable source arrived.");
    expect(await rig.providerRequests()).toBe(1);
  } finally { await page.evaluate(() => { (window as unknown as TestWindow).restoreNoteRead?.(); }); }
});

test("accepted requests use captured source content and the next request checks again", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, context: OFF },
    extraFiles: { "Selected.md": BODY },
    providerReply: [{ match: BODY, replies: ["The captured source arrived."] }],
  });
  await page.evaluate(() => {
    const win = window as unknown as TestWindow;
    win.app.commands.executeCommandById("claude-companion:open-chat");
    const router = win.app.plugins.plugins["claude-companion"]!.router();
    const original = router.chatToolCapable;
    const gate: Gate = { entered: false, restore: () => { router.chatToolCapable = original; } };
    win.noteGate = gate;
    router.chatToolCapable = async () => {
      gate.entered = true;
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return original.call(router);
    };
  });
  try {
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    await input.fill("@Selected");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText("Selected");
    await input.press("Enter");
    await input.fill("Summarize this source.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await page.waitForFunction(() => (window as unknown as TestWindow).noteGate?.entered);
    await page.evaluate(async () => {
      const win = window as unknown as TestWindow;
      await win.app.vault.delete(win.app.vault.getAbstractFileByPath("Selected.md"));
      win.noteGate?.release?.();
      win.noteGate?.restore();
    });
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The captured source arrived.");
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill("Ask again using the selected source.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(page.locator(".notice").filter({ hasText: "Request not sent" })).toContainText("Selected.md");
    await expect(input).toHaveValue("Ask again using the selected source.");
    expect(await rig.providerRequests()).toBe(1);
  } finally {
    await page.evaluate(() => { const gate = (window as unknown as TestWindow).noteGate; gate?.release?.(); gate?.restore(); });
  }
});
