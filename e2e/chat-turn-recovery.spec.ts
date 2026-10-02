import { expect, test } from "./fixtures";

test("a hung Claude Code turn stays visible, stops, and allows the next request", async ({ rig }) => {
  const { page } = await rig.reset({ claudeCli: true });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root").first();
  await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });

  await chat.locator(".cc-input").fill("hang forever");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-turn-status")).toContainText("Working", { timeout: 15_000 });
  const send = chat.locator('[aria-label="Stop generating"]');
  await expect(send).toBeVisible();
  await send.click();
  await expect(chat.locator('[aria-label="Send message"]')).toBeVisible({ timeout: 10_000 });
  await expect(chat.locator(".cc-turn-status")).toHaveCount(0);

  await chat.locator(".cc-input").fill("ping");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
});

test("saved prompts can be reused and the last answer regenerated after plugin reload", async ({ rig }) => {
  const { page } = await rig.reset({ claudeCli: true });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root").first();
  await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
  await chat.locator(".cc-input").fill("ping");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });

  await rig.reloadPlugin();
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const reopened = page.locator(".cc-chat-root").first();
  await expect(reopened.locator('.cc-user [aria-label="Copy prompt"]')).toBeVisible();
  await reopened.locator('.cc-user [aria-label="Copy prompt"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ping");
  await reopened.locator('.cc-user [aria-label="Use again"]').click();
  await expect(reopened.locator(".cc-input")).toHaveValue("ping");
  await reopened.locator(".cc-input").fill("");
  await reopened.locator('.cc-assistant [aria-label="Regenerate"]').click();
  await expect(reopened.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });
});

test("a saved edit can be reviewed and applied after plugin reload", async ({ rig }) => {
  const { page } = await rig.reset({ claudeCli: true });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root").first();
  await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
  await chat.locator(".cc-input").fill("ping");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });

  await page.evaluate(async () => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, {
      getActiveConversation(): { id: string } | null;
      saveChatEditProposal(id: string, proposal: { path: string; edits: { old_str: string; new_str: string }[] }): Promise<void>;
    }> } } }).app;
    const plugin = app.plugins.plugins["claude-companion"]!;
    await plugin.saveChatEditProposal(plugin.getActiveConversation()!.id, {
      path: "Research/Alpha/Documents/Draft.md",
      edits: [{ old_str: "Draft fixture.", new_str: "Revised fixture." }],
    });
  });
  await rig.reloadPlugin();
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const reopened = page.locator(".cc-chat-root").first();
  await reopened.locator(".cc-edit-recovery").getByRole("button", { name: "Review proposed edit" }).click();
  await page.getByRole("button", { name: "Apply selected" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown; cachedRead(file: unknown): Promise<string> } } }).app;
    return app.vault.cachedRead(app.vault.getAbstractFileByPath("Research/Alpha/Documents/Draft.md"));
  })).toContain("Revised fixture.");
  await expect(reopened.locator(".cc-edit-recovery")).toHaveCount(0);
});

test("a saved edit inside a table is reviewed in the modal, not inline, in Live Preview", async ({ rig }) => {
  const { page } = await rig.reset({ claudeCli: true, extraFiles: { "Notes/Table.md": "# Table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" } });
  const openTable = () => page.evaluate(async () => {
    const app = (window as unknown as { app: { workspace: { openLinkText(link: string, source: string, newLeaf: boolean): Promise<void> } } }).app;
    await app.workspace.openLinkText("Notes/Table", "", false);
  });
  const openChat = () => page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  await openTable();
  await openChat();
  const chat = page.locator(".cc-chat-root").first();
  await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
  await chat.locator(".cc-input").fill("ping");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });

  await page.evaluate(async () => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, {
      getActiveConversation(): { id: string } | null;
      saveChatEditProposal(id: string, proposal: { path: string; edits: { old_str: string; new_str: string }[] }): Promise<void>;
    }> } } }).app;
    const plugin = app.plugins.plugins["claude-companion"]!;
    await plugin.saveChatEditProposal(plugin.getActiveConversation()!.id, {
      path: "Notes/Table.md",
      edits: [{ old_str: "| a | b |", new_str: "| a | c |" }],
    });
  });
  await rig.reloadPlugin();
  await openTable();
  await openChat();
  const reopened = page.locator(".cc-chat-root").first();
  await reopened.locator(".cc-edit-recovery").getByRole("button", { name: "Review proposed edit" }).click();
  await expect(page.getByRole("button", { name: "Apply selected" })).toBeVisible();
  await expect(page.locator(".cc-inline-bar")).toHaveCount(0);
  await page.getByRole("button", { name: "Apply selected" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown; cachedRead(file: unknown): Promise<string> } } }).app;
    return app.vault.cachedRead(app.vault.getAbstractFileByPath("Notes/Table.md"));
  })).toContain("| a | c |");
});

test("a saved edit can be discarded without touching the note", async ({ rig }) => {
  const { page } = await rig.reset({ claudeCli: true });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root").first();
  await expect(chat).toContainText("● Claude Code", { timeout: 15_000 });
  await chat.locator(".cc-input").fill("ping");
  await chat.locator(".cc-input").press("Enter");
  await expect(chat.locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 30_000 });

  await page.evaluate(async () => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, {
      getActiveConversation(): { id: string } | null;
      saveChatEditProposal(id: string, proposal: { path: string; edits: { old_str: string; new_str: string }[] }): Promise<void>;
    }> } } }).app;
    const plugin = app.plugins.plugins["claude-companion"]!;
    await plugin.saveChatEditProposal(plugin.getActiveConversation()!.id, {
      path: "Research/Alpha/Documents/Draft.md",
      edits: [{ old_str: "Draft fixture.", new_str: "Revised fixture." }],
    });
  });
  await rig.reloadPlugin();
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const reopened = page.locator(".cc-chat-root").first();
  await reopened.locator(".cc-edit-recovery").getByRole("button", { name: "Discard" }).click();
  await expect(reopened.locator(".cc-edit-recovery")).toHaveCount(0);
  await rig.reloadPlugin();
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  await expect(page.locator(".cc-chat-root").first().locator(".cc-msg.cc-assistant").last()).toContainText("pong from claude code", { timeout: 15_000 });
  await expect(page.locator(".cc-chat-root").first().locator(".cc-edit-recovery")).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown; cachedRead(file: unknown): Promise<string> } } }).app;
    return app.vault.cachedRead(app.vault.getAbstractFileByPath("Research/Alpha/Documents/Draft.md"));
  })).toContain("Draft fixture.");
});
