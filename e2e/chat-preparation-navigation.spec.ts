import { expect, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";

type Gate = { entered: boolean; release?(): void; restore(): void };
type TestWindow = Window & {
  app: { commands: { executeCommandById(id: string): void }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> } };
  __preparationGate?: Gate;
};

const scenarios = [
  { stage: "project lookup", sendNext: false },
  { stage: "tool capability", sendNext: false },
  { stage: "ontology loading", sendNext: false },
  { stage: "context save", sendNext: false },
  { stage: "project lookup", sendNext: true },
] as const;

for (const scenario of scenarios) {
  test(`navigation during ${scenario.stage} ${scenario.sendNext ? "allows the new chat to send" : "preserves the new chat draft"}`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: scenario.stage === "ontology loading" } },
      providerReply: [{ match: "My separate new question", replies: ["The new answer."] }],
      providerFail: [{ match: "Summarize the earlier project", status: 422 }],
    });
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-chat"));
    await page.evaluate((stage) => {
      const win = window as unknown as TestWindow;
      const plugin = win.app.plugins.plugins["claude-companion"]!;
      const gate: Gate = { entered: false, restore: () => undefined };
      win.__preparationGate = gate;
      const hold = async () => {
        if (gate.entered) return;
        gate.entered = true;
        await new Promise<void>((resolve) => { gate.release = resolve; });
      };
      if (stage === "project lookup") {
        const original = plugin.chatProjectFor;
        gate.restore = () => { plugin.chatProjectFor = original; };
        plugin.chatProjectFor = async (id) => { if (id) await hold(); return original.call(plugin, id); };
      } else if (stage === "tool capability") {
        const router = plugin.router();
        const original = router.chatToolCapable;
        gate.restore = () => { router.chatToolCapable = original; };
        router.chatToolCapable = async () => { await hold(); return original.call(router); };
      } else if (stage === "ontology loading") {
        const original = plugin.loadedOntology;
        gate.restore = () => { plugin.loadedOntology = original; };
        plugin.loadedOntology = async () => { await hold(); return original.call(plugin); };
      } else {
        const store = plugin.conversations();
        const original = store.setTurnContext;
        gate.restore = () => { store.setTurnContext = original; };
        store.setTurnContext = async (...args) => { const result = original.apply(store, args); await hold(); return result; };
      }
    }, scenario.stage);
    try {
      const chat = page.locator(".cc-chat-root");
      const input = chat.locator(".cc-input");
      const send = chat.getByRole("button", { name: /^Send(?: message)?$/ });
      await input.fill("Summarize the earlier project");
      await send.click();
      await page.waitForFunction(() => (window as unknown as TestWindow).__preparationGate?.entered);
      await chat.getByRole("button", { name: "New chat", exact: true }).click();
      await input.fill("My separate new question");
      if (scenario.sendNext) {
        await send.click();
        await expect(chat.locator(".cc-assistant .cc-body")).toHaveText("The new answer.");
        await expect(chat.locator(".cc-user")).toContainText("My separate new question");
        expect(await rig.providerRequests()).toBe(1);
      }
      await page.evaluate(() => (window as unknown as TestWindow).__preparationGate?.release?.());
      await expect.poll(() => page.evaluate(() => {
        const store = (window as unknown as TestWindow).app.plugins.plugins["claude-companion"]!.conversations();
        return store.list().find((entry) => entry.messages.some((message) => message.content === "Summarize the earlier project"))?.activeTurn?.state;
      })).toBe("interrupted");
      await expect(chat.locator(".cc-msg.cc-user")).toHaveCount(scenario.sendNext ? 1 : 0);
      await expect(input).toHaveValue(scenario.sendNext ? "" : "My separate new question");
      expect(await rig.providerRequests()).toBe(scenario.sendNext ? 1 : 0);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("selected-chat-after-preparation.png") });
    } finally {
      await page.evaluate(() => {
        const win = window as unknown as TestWindow;
        win.__preparationGate?.release?.(); win.__preparationGate?.restore(); delete win.__preparationGate;
      });
      page.off("pageerror", onError);
    }
  });
}
