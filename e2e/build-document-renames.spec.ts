import { expect, test } from "./fixtures";

type Run = { id: string; specPath: string; trackerPath: string; status: string; tasks: { title: string; status: string }[]; trackerError?: string };
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>; getActiveFile(): { path: string; basename: string } | null };
  vault: { getAbstractFileByPath(path: string): unknown; createFolder(path: string): Promise<unknown>; create(path: string, body: string): Promise<unknown>; read(file: unknown): Promise<string>; delete(file: unknown): Promise<void> };
  fileManager: { renameFile(file: unknown, path: string): Promise<void> };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): Run } }> };
} };

const current = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const run = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
  return { id: run.id, specPath: run.specPath, trackerPath: run.trackerPath, status: run.status, tasks: run.tasks, trackerError: run.trackerError };
});

async function pausedBuild(rig: import("./fixtures").Rig) {
  const { page } = await rig.reset({ fakeClaudeCode: true });
  await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; await app.workspace.openLinkText("Build plan", "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); });
  await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
  const runner = page.locator(".cc-build-view");
  await runner.getByRole("button", { name: "Start build", exact: true }).click();
  await runner.getByRole("button", { name: "Pause after current task", exact: true }).click();
  await expect(runner.getByRole("status")).toContainText("Build paused", { timeout: 15000 });
  return { page, runner };
}

test("build documents follow native file renames and a folder move during execution", async ({ rig }, testInfo) => {
  const { page, runner } = await pausedBuild(rig);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await current(page);
  for (const [button, title, field] of [["Open spec", "Renamed build spec", "specPath"], ["Open tracker note", "Renamed build tracker", "trackerPath"]] as const) {
    await runner.getByRole("button", { name: button, exact: true }).click();
    await page.locator(".inline-title").fill(title);
    await page.locator(".inline-title").press("Enter");
    await expect.poll(async () => (await current(page))[field]).toBe(`Claude/Builds/${title}.md`);
  }
  await page.evaluate(async () => { await (window as unknown as AppWindow).app.vault.createFolder("Archive"); });
  await runner.getByRole("button", { name: "Resume build", exact: true }).click();
  const statusAtMove = await page.evaluate(async () => {
    const app = (window as unknown as AppWindow).app;
    const status = app.plugins.plugins["claude-companion"]!.research().activeBuildRun().status;
    await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Claude/Builds"), "Archive/Builds");
    return status;
  });
  expect(statusAtMove).toBe("running");
  await expect(runner.getByRole("status")).toContainText("Build complete", { timeout: 15000 });
  await expect.poll(async () => (await current(page)).trackerPath).toBe("Archive/Builds/Renamed build tracker.md");
  const tracker = await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; return app.vault.read(app.vault.getAbstractFileByPath("Archive/Builds/Renamed build tracker.md")); });
  expect(tracker).toContain("**Status:** Complete");
  expect(tracker).toContain("**Progress:** 2 / 2");
  await rig.reloadPlugin();
  expect(await current(page)).toMatchObject({ id: before.id, status: "completed", specPath: "Archive/Builds/Renamed build spec.md", trackerPath: "Archive/Builds/Renamed build tracker.md" });
  for (const [button, path] of [["Open spec", "Archive/Builds/Renamed build spec.md"], ["Open tracker note", "Archive/Builds/Renamed build tracker.md"]]) {
    await runner.getByRole("button", { name: button!, exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(path);
  }
  await expect(runner.getByRole("alert")).toBeHidden();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("renamed-and-moved-tracker-complete.png"), animations: "disabled" });
});

test("a missing tracker has persistent feedback and can be updated again without rerunning tasks", async ({ rig }, testInfo) => {
  const { page, runner } = await pausedBuild(rig);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await current(page);
  await page.evaluate(async (path) => { const app = (window as unknown as AppWindow).app; await app.vault.delete(app.vault.getAbstractFileByPath(path)); }, before.trackerPath);
  await runner.getByRole("button", { name: "Resume build", exact: true }).click();
  await expect(runner.getByRole("status")).toContainText("Build complete", { timeout: 15000 });
  await expect(runner.getByRole("alert")).toContainText("File not found");
  const completed = await current(page);
  expect(completed.tasks.every((task) => task.status === "completed")).toBe(true);
  await rig.reloadPlugin();
  await expect(runner.getByRole("alert")).toContainText("File not found");
  await runner.getByRole("button", { name: "Open tracker note", exact: true }).click();
  await expect(page.locator(".notice").filter({ hasText: "Couldn't open build document" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("missing-tracker-feedback.png"), animations: "disabled" });
  await page.evaluate(async (path) => { await (window as unknown as AppWindow).app.vault.create(path, "Restored tracker"); }, before.trackerPath);
  await runner.getByRole("button", { name: "Retry tracker update", exact: true }).click();
  await expect(runner.getByRole("alert")).toBeHidden();
  expect(await current(page)).toEqual({ ...completed, trackerError: undefined });
  const tracker = await page.evaluate(async (path) => { const app = (window as unknown as AppWindow).app; return app.vault.read(app.vault.getAbstractFileByPath(path)); }, before.trackerPath);
  expect(tracker).toContain("**Status:** Complete");
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("restored-tracker-updated.png"), animations: "disabled" });
});
