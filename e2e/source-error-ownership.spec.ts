import { expect, test } from "./fixtures";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
type Gate = { entered: boolean; release(): void; restore(): void };
type W = Window & { gate?: Gate; app: { commands: { executeCommandById(id: string): void }; vault: { createBinary(path: string, bytes: ArrayBuffer): Promise<unknown>; cachedRead(file: { path: string }): Promise<string>; readBinary(file: { path: string }): Promise<ArrayBuffer> } } };
for (const kind of ["image", "note"] as const) for (const navigate of [false, true]) test(`a selected ${kind} read failure ${navigate ? "stays out of a newer chat" : "remains actionable in its draft"}`, async ({ rig }, info) => {
  const { page } = await rig.reset({ extraFiles: { "ScopedSource.md": "Scoped note contents." }, settingsOverride: { agentModeEnabled: false, context: { activeNote: false, selection: false, linkedNotes: false, searchVault: false } }, providerReply: [{ match: PNG, replies: ["Recovered source received."] }, { match: "Scoped note contents.", replies: ["Recovered source received."] }, { match: "/./", replies: ["Seed answer."] }] });
  const errors: string[] = [], onError = (error: Error) => errors.push(error.message); page.on("pageerror", onError);
  try {
    await page.evaluate(async png => { const app = (window as unknown as W).app; await app.vault.createBinary("ScopedChart.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer); app.commands.executeCommandById("claude-companion:new-chat-tab"); }, PNG);
    const chat = page.locator(".cc-chat-root"), input = chat.locator(".cc-input");
    await input.fill("Source reading conversation"); await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click(); await expect(chat.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
    await input.fill(kind === "image" ? "@ScopedChart" : "@ScopedSource"); await expect(chat.locator(".cc-at-item.is-selected")).toContainText(kind === "image" ? "ScopedChart" : "ScopedSource"); await input.press("Enter");
    await input.fill("  Explain my selected source.  ");
    await page.evaluate(type => {
      const win = window as unknown as W, vault = win.app.vault;
      let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
      const gate: Gate = { entered: false, release, restore: () => undefined }; win.gate = gate;
      if (type === "image") { const original = vault.readBinary; gate.restore = () => { vault.readBinary = original; }; vault.readBinary = async file => { if (file.path === "ScopedChart.png") { gate.entered = true; await waiting; throw new Error("Source read failed"); } return original.call(vault, file); }; }
      else { const original = vault.cachedRead; gate.restore = () => { vault.cachedRead = original; }; vault.cachedRead = async file => { if (file.path === "ScopedSource.md") { gate.entered = true; await waiting; throw new Error("Source read failed"); } return original.call(vault, file); }; }
    }, kind);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as W).gate?.entered)).toBe(true);
    if (navigate) { await chat.getByRole("button", { name: "New chat", exact: true }).click(); await input.fill("A separate question I have not sent."); }
    await page.evaluate(async () => { (window as unknown as W).gate?.release(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(await page.locator(".notice").filter({ hasText: "Source read failed" }).count()).toBe(navigate ? 0 : 1);
    await expect(input).toHaveValue(navigate ? "A separate question I have not sent." : "  Explain my selected source.  "); expect(await rig.providerRequests()).toBe(1);
    await page.screenshot({ path: info.outputPath("source-error-scoped-to-request-draft.png") });
    await page.evaluate(() => { (window as unknown as W).gate?.restore(); });
    if (navigate) {
      await chat.getByRole("button", { name: "Resume a past conversation", exact: true }).click();
      await page.locator(".cc-session-row").filter({ hasText: "Source reading conversation" }).click();
      await expect(input).toHaveValue("  Explain my selected source.  ");
    }
    await input.fill(kind === "image" ? "@ScopedChart" : "@ScopedSource");
    await expect(chat.locator(".cc-at-item.is-selected")).toContainText(kind === "image" ? "ScopedChart" : "ScopedSource");
    await input.press("Enter"); await input.fill("Explain my selected source.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText("Recovered source received.");
    expect(await rig.providerRequests()).toBe(2);
    if (navigate) { await chat.getByRole("button", { name: "New chat", exact: true }).click(); await expect(input).toHaveValue("A separate question I have not sent."); }
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => { (window as unknown as W).gate?.release(); (window as unknown as W).gate?.restore(); }); page.off("pageerror", onError); }
});
