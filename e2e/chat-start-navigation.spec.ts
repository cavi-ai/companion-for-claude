import { expect, test } from "./fixtures";
import type { ConversationsController } from "../src/conversations/controller";

type SaveGate = { entered: boolean; release?(): void; restore(): void };
type TestWindow = Window & {
  app: {
    commands: { executeCommandById(id: string): void };
    plugins: { plugins: Record<string, { conversations(): ConversationsController }> };
  };
  __turnSaveGate?: SaveGate;
};

for (const destination of ["New chat", "saved conversation"] as const) {
  test(`${destination} stays selected when an earlier request finishes saving`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } },
      providerReply: [{ match: ".", replies: ["The recovered answer."] }],
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-chat"));
    const chat = page.locator(".cc-chat-root");
    const input = chat.locator(".cc-input");
    const send = chat.getByRole("button", { name: /^Send(?: message)?$/ });
    const history = chat.getByRole("button", { name: "Resume a past conversation", exact: true });
    if (destination === "saved conversation") {
      await input.fill("Existing conversation question");
      await send.click();
      await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
      await chat.getByRole("button", { name: "New chat", exact: true }).click();
    }
    const priorRequests = await rig.providerRequests();
    await page.evaluate(() => {
      const win = window as unknown as TestWindow;
      const store = win.app.plugins.plugins["claude-companion"]!.conversations();
      const original = store.beginTurn;
      const gate: SaveGate = { entered: false, restore: () => { store.beginTurn = original; } };
      win.__turnSaveGate = gate;
      store.beginTurn = async (...args: Parameters<ConversationsController["beginTurn"]>) => {
        const result = original.apply(store, args);
        gate.entered = true;
        await new Promise<void>((resolve) => { gate.release = resolve; });
        return result;
      };
    });
    try {
      const question = "Summarize the earlier project";
      await input.fill(question);
      await send.click();
      await page.waitForFunction(() => (window as unknown as TestWindow).__turnSaveGate?.entered);
      if (destination === "New chat") {
        await chat.getByRole("button", { name: "New chat", exact: true }).click();
      } else {
        await history.click();
        await page.locator(".cc-session-row").filter({ hasText: "Existing conversation question" }).click();
        await expect(chat.locator(".cc-user")).toContainText("Existing conversation question");
      }
      await input.fill("My separate new question");
      await page.evaluate(() => (window as unknown as TestWindow).__turnSaveGate?.release?.());
      await expect(page.locator(".notice").filter({ hasText: "Request saved but not sent because you switched chats" })).toBeVisible();
      await expect(chat.locator(".cc-msg.cc-user")).toHaveCount(destination === "New chat" ? 0 : 1);
      await expect(input).toHaveValue("My separate new question");
      expect(await rig.providerRequests()).toBe(priorRequests);
      await page.screenshot({ path: testInfo.outputPath("selected-chat-and-draft-preserved.png") });
      await page.evaluate(() => (window as unknown as TestWindow).__turnSaveGate?.restore());

      await history.click();
      await page.locator(".cc-session-row").filter({ hasText: question }).click();
      await expect(chat.locator(".cc-interrupted-turn").getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      const saved = await page.evaluate((text) => {
        const store = (window as unknown as TestWindow).app.plugins.plugins["claude-companion"]!.conversations();
        const entry = store.list().find((item) => item.messages.some((message) => message.content === text));
        return { state: entry?.activeTurn?.state, error: entry?.activeTurn?.error };
      }, question);
      expect(saved.state).toBe("interrupted");
      expect(saved.error).toContain("not sent");
      await rig.reloadPlugin();
      await expect(chat.locator(".cc-interrupted-turn").getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await chat.locator(".cc-interrupted-turn").getByRole("button", { name: "Resume", exact: true }).click();
      await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("The recovered answer.");
      expect(await rig.providerRequests()).toBe(priorRequests + 1);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("saved-request-resumed-after-reload.png") });
    } finally {
      await page.evaluate(() => {
        const win = window as unknown as TestWindow;
        win.__turnSaveGate?.release?.();
        win.__turnSaveGate?.restore();
        delete win.__turnSaveGate;
      });
    }
  });
}
