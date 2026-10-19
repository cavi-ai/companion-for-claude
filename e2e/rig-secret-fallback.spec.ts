import { expect, test } from "./fixtures";

type TestWindow = Window & {
  restoreRigSecretBackend?: () => void;
  app: {
    secretStorage: { getSecret(id: string): string | null; setSecret(id: string, value: string): void };
    commands: { executeCommandById(id: string): void };
    plugins: { plugins: Record<string, { settings: { apiKey: string } }> };
  };
};

test("rig reset retains its dummy credential when device secret storage refuses writes", async ({ rig }) => {
  const { page } = await rig.reset();
  try {
    await page.evaluate(() => {
      const target = window as unknown as TestWindow;
      const store = target.app.secretStorage;
      const get = Object.getOwnPropertyDescriptor(store, "getSecret");
      const set = Object.getOwnPropertyDescriptor(store, "setSecret");
      target.restoreRigSecretBackend = () => {
        if (get) Object.defineProperty(store, "getSecret", get);
        else Reflect.deleteProperty(store, "getSecret");
        if (set) Object.defineProperty(store, "setSecret", set);
        else Reflect.deleteProperty(store, "setSecret");
      };
      store.getSecret = () => null;
      store.setSecret = () => {};
    });
    await rig.reset({ providerReply: [{ match: "/./", replies: ["Reset credential retained."] }] });
    expect(await page.evaluate(() => (window as unknown as TestWindow).app.plugins.plugins["claude-companion"]!.settings.apiKey === "e2e-key")).toBe(true);
    await page.evaluate(() => (window as unknown as TestWindow).app.commands.executeCommandById("claude-companion:open-chat"));
    const chat = page.locator(".cc-chat-root");
    await chat.locator("textarea").fill("Check reset credential");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toContainText("Reset credential retained.");
    expect(await rig.providerRequests()).toBe(1);
  } finally {
    await page.evaluate(() => { const target = window as unknown as TestWindow; target.restoreRigSecretBackend?.(); delete target.restoreRigSecretBackend; });
  }
});
