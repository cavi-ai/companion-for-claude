import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: {
    getLeaf(newLeaf: boolean): { setViewState(state: { type: string; active: boolean }): Promise<void> };
    getLeavesOfType(type: string): { id: string }[];
    openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>;
  };
  vault: { getMarkdownFiles(): { path: string }[]; read(file: { path: string }): Promise<string> };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): { id: string; status: string } | null } }> };
} };

test("Open Build Runner works without a note and reopens saved work without creating or starting a build", async ({ rig }, testInfo) => {
  const { page } = await rig.reset();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const runner = page.locator(".cc-build-view");
  const command = async () => {
    await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("command-palette:open"));
    await page.locator(".prompt-input").fill("Open Build Runner");
    await page.locator(".suggestion-item").filter({ hasText: "Open Build Runner" }).click();
    await expect(runner).toBeVisible();
  };
  const state = () => page.evaluate(async () => {
    const app = (window as unknown as AppWindow).app;
    const run = app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
    const files = await Promise.all(app.vault.getMarkdownFiles().filter((file) => file.path.startsWith("Claude/Builds/")).map(async (file) => ({ path: file.path, content: await app.vault.read(file) })));
    return { run: run && { id: run.id, status: run.status }, files };
  });
  await page.evaluate(async () => { await (window as unknown as AppWindow).app.workspace.getLeaf(false).setViewState({ type: "empty", active: true }); });
  await command();
  await expect(runner.locator("h2")).toHaveText("No build selected");
  await expect(runner.locator("button:visible")).toHaveCount(0);
  expect(await state()).toEqual({ run: null, files: [] });
  await page.screenshot({ path: testInfo.outputPath("open-runner-without-a-build.png"), animations: "disabled" });

  await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; await app.workspace.openLinkText("Build plan", "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); });
  await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
  await expect(runner.getByRole("status")).toContainText("Ready");
  const before = await state();
  expect(before.files).toHaveLength(2);
  await page.locator('.workspace-tab-header[data-type="claude-build-runner"]').click();
  await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("workspace:close"));
  await expect(runner).toHaveCount(0);
  await rig.reloadPlugin();
  await command();
  await expect(runner.getByRole("status")).toContainText("Ready");
  await expect(runner.getByRole("button", { name: "Start build", exact: true })).toBeVisible();
  const leafId = await page.evaluate(() => (window as unknown as AppWindow).app.workspace.getLeavesOfType("claude-build-runner")[0]!.id);
  await command();
  expect(await page.evaluate(() => (window as unknown as AppWindow).app.workspace.getLeavesOfType("claude-build-runner").map((leaf) => leaf.id))).toEqual([leafId]);
  expect(await state()).toEqual(before);
  expect(await rig.providerRequests()).toBe(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("saved-build-reopened-from-palette.png"), animations: "disabled" });
});
