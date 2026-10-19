import { expect, test } from "./fixtures";

type Run = { specPath: string; trackerPath: string; createdAt: number };
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>; getActiveFile(): { path: string } | null };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): Run } }> };
} };

test("build documents use the local creation day through execution and reload", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ fakeClaudeCode: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const read = (path: string) => page.evaluate((value) => { const { vault } = (window as unknown as AppWindow).app; return vault.read(vault.getAbstractFileByPath(value)); }, path);
    await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; await app.workspace.openLinkText("Build plan", "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); });
    await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
    const runner = page.locator(".cc-build-view");
    await expect(runner.getByRole("status")).toContainText("Ready");
    const dates = await page.evaluate(() => {
      const run = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
      const date = new Date(run.createdAt);
      return { specPath: run.specPath, trackerPath: run.trackerPath, localDay: [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"), utcDay: date.toISOString().slice(0, 10), zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    });
    expect(dates.zone).toBe("America/New_York");
    for (const path of [dates.specPath, dates.trackerPath]) expect(await read(path)).toContain(`created: "${dates.localDay}"`);
    await runner.getByRole("button", { name: "Start build", exact: true }).click();
    await expect(runner.getByRole("status")).toContainText("Build complete", { timeout: 15000 });
    await expect.poll(() => read(dates.trackerPath)).toContain("**Status:** Complete");
    expect(await read(dates.trackerPath)).toContain(`created: "${dates.localDay}"`);
    await rig.reloadPlugin();
    for (const path of [dates.specPath, dates.trackerPath]) expect(await read(path)).toContain(`created: "${dates.localDay}"`);
    await runner.getByRole("button", { name: "Open spec", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(dates.specPath);
    await page.screenshot({ path: testInfo.outputPath("build-local-creation-date.png"), animations: "disabled" });
    await testInfo.attach("build-dates.json", { body: JSON.stringify(dates, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally {
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "" });
    await cdp.detach();
  }
});
