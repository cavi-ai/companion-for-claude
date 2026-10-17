import { expect, test } from "./fixtures";
import type { Conversation } from "../src/conversations/store";

test.use({ actionTimeout: 10_000 });

for (const outcome of ["failure", "stop", "reload"] as const) {
  test(`regeneration preserves the answer after ${outcome} and replaces it on success`, async ({ rig }, testInfo) => {
    const original = "Four participants preferred the checklist; productivity improvements remain unproven.";
    const replacement = "The pilot had four participants and no control group. Preference is not evidence of productivity.";
    const prompt = "Summarize the pilot findings.";
    const { page } = await rig.reset({
      embedStub: true,
      extraFiles: { "Pilot reading.md": "Four participants preferred a checklist. No control group or established productivity improvement." },
      settingsOverride: { agentModeEnabled: false, autoTagOnSave: false, semanticEnabled: false, ollamaModel: "stub-embed" },
      providerReply: [{ match: "/./", replies: [original] }],
    });
    const openChat = () => page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    const saved = () => page.evaluate(async () => {
      const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, {
        loadData(): Promise<{ conversations: Conversation[]; activeConversationId: string }>;
      }> } } }).app.plugins.plugins["claude-companion"]!;
      const data = await plugin.loadData();
      return data.conversations.find((conversation) => conversation.id === data.activeConversationId)!;
    });
    await page.getByText("Pilot reading", { exact: true }).click();
    await openChat();
    const chat = page.locator(".cc-chat-root");
    await chat.locator("textarea").fill(prompt);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await expect.poll(async () => (await saved()).messages.at(-1)?.content).toBe(original);
    const exchange = (await saved()).messages;

    await rig.control.setStubs(outcome === "failure"
      ? { providerFail: [{ match: "/./", status: 503 }] }
      : { providerReply: [{ match: "/./", replies: [replacement] }], providerDelayMs: 5000 });
    await chat.getByRole("button", { name: "Regenerate", exact: true }).click();
    if (outcome !== "failure") {
      await expect(chat.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
      await expect(chat.locator(".cc-assistant .cc-body").first()).toHaveText(original);
      expect((await saved()).messages).toEqual(exchange);
      if (outcome === "stop") await chat.getByRole("button", { name: "Stop generating", exact: true }).click();
    }
    if (outcome !== "reload") {
      await expect(chat).toContainText("Previous answer kept.");
      await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      if (outcome === "failure") await expect(chat.locator(".cc-error")).toBeVisible();
      expect(await chat.locator(".cc-agent-notice").allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining("answered locally")]));
      await expect.poll(async () => (await saved()).messages).toEqual(exchange);
      await expect(chat.locator(".cc-user .cc-context-note")).toHaveText("+ context: active note: Pilot reading.md");
      await expect(chat.locator(".cc-assistant .cc-context-note")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("retained-answer.png"), animations: "disabled" });
    }

    await rig.reloadPlugin();
    await openChat();
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText(original);
    await expect(chat).toContainText("Previous answer kept.");
    expect((await saved()).messages).toEqual(exchange);
    await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
    await rig.control.setStubs({ providerReply: [{ match: "/./", replies: [replacement] }], providerDelayMs: 500 });
    await chat.locator(".cc-interrupted-turn").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(chat.locator(".cc-regeneration")).toBeVisible();
    await expect(chat.locator(".cc-assistant:not(.cc-regeneration) .cc-body")).toHaveText(original);
    await expect(chat.locator(".cc-assistant .cc-body")).toHaveText([replacement]);
    await expect(chat.locator(".cc-user")).toHaveCount(1);
    await expect.poll(async () => (await saved()).messages.map((message) => message.content)).toEqual([prompt, replacement]);
    expect((await saved()).activeTurn).toBeUndefined();
  });
}
