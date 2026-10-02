import { expect, test } from "./fixtures";

const ORDER = [
  "---",
  "name: Follow ups",
  "description: Mark shipped action items",
  "on_note:",
  "  folder: Meetings",
  "enabled: true",
  "---",
  "Review the note and mark shipped action items done.",
  "",
  "{note}",
  "",
].join("\n");

const PROPOSE = JSON.stringify({
  name: "propose_note_edit",
  input: { path: "Meetings/Standup.md", edits: [{ old_str: "- [ ] ship", new_str: "- [x] ship" }], description: "Mark shipped" },
});

type OrdersSeam = { pending: Map<string, number>; tick(): Promise<void> };
type PluginSeam = { ordersState: Record<string, unknown>; standingOrders(): OrdersSeam };
type AppSeam = { app: { plugins: { plugins: Record<string, PluginSeam> }; vault: { createFolder(path: string): Promise<unknown>; create(path: string, content: string): Promise<unknown>; getFiles(): Array<{ path: string }>; getAbstractFileByPath(path: string): unknown; cachedRead(file: unknown): Promise<string> }; commands: { executeCommandById(id: string): Promise<void> } } };

test("a standing order runs on a new note and its proposed edit is reviewed in the Inbox", async ({ rig }) => {
  const harness = await rig.reset({
    extraFiles: { "Claude/Templates/Follow ups.md": ORDER },
    providerReply: [{ match: "/Meetings\\/Standup/", replies: [`TOOL_USE:${PROPOSE}`, "Marked the action item."] }],
  });
  const { page } = harness;
  try {
    await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as AppSeam).app.plugins.plugins["claude-companion"]?.ordersState ?? {}).length), { timeout: 20_000 }).toBe(1);
    await page.evaluate(async () => {
      const { vault } = (window as unknown as AppSeam).app;
      await vault.createFolder("Meetings");
      await vault.create("Meetings/Standup.md", "- [ ] ship\n");
    });

    // The 60s settle window is not waited out: rewind the pending note's last-event time past it, then run the tick.
    await expect.poll(() => page.evaluate(() => (window as unknown as AppSeam).app.plugins.plugins["claude-companion"]!.standingOrders().pending.has("Meetings/Standup.md"))).toBe(true);
    await page.evaluate(async () => {
      const orders = (window as unknown as AppSeam).app.plugins.plugins["claude-companion"]!.standingOrders();
      orders.pending.set("Meetings/Standup.md", Date.now() - 61_000);
      await orders.tick();
    });

    await expect.poll(() => page.evaluate(() => (window as unknown as AppSeam).app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith("Claude/Orders/Follow ups/"))), { timeout: 20_000 }).toHaveLength(1);
    const runNote = await page.evaluate(async () => {
      const { app } = window as unknown as AppSeam;
      const path = app.vault.getFiles().map((f) => f.path).find((p) => p.startsWith("Claude/Orders/Follow ups/"))!;
      return app.vault.cachedRead(app.vault.getAbstractFileByPath(path));
    });
    expect(runNote).toContain("type: \"order-run\"");

    await page.evaluate(async () => {
      await (window as unknown as AppSeam).app.commands.executeCommandById("claude-companion:open-source-inbox");
    });
    await expect(page.locator(".cc-inbox-orders .cc-eyebrow")).toHaveText("PROPOSED EDITS", { timeout: 15_000 });
    await expect(page.locator(".cc-inbox-order-edit")).toHaveCount(1);

    await page.locator(".cc-inbox-order-review").click();
    await page.getByRole("button", { name: "Apply selected" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const { app } = window as unknown as AppSeam;
      return app.vault.cachedRead(app.vault.getAbstractFileByPath("Meetings/Standup.md"));
    })).toContain("- [x] ship");
    await expect(page.locator(".cc-inbox-order-edit")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
