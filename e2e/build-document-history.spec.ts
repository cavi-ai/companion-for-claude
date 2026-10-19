import { expect, test } from "./fixtures";

type Run = { id: string; specPath: string; trackerPath: string; status: string };
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>; getActiveFile(): { path: string } | null };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string>; append(file: unknown, content: string): Promise<void>; modify(file: unknown, content: string): Promise<void> };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): Run }; _build: { serializeState(): { buildRuns: Run[] } } }> };
} };

test("creating and running another build preserves earlier specs and trackers", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ fakeClaudeCode: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const active = () => page.evaluate(() => {
    const run = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
    return { id: run.id, specPath: run.specPath, trackerPath: run.trackerPath, status: run.status };
  });
  const read = (path: string) => page.evaluate((value) => { const { vault } = (window as unknown as AppWindow).app; return vault.read(vault.getAbstractFileByPath(value)); }, path);
  const propose = async () => {
    await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; await app.workspace.openLinkText("Build plan", "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); });
    await expect(page.locator(".modal")).toContainText("Build from this plan?");
  };
  const create = async () => {
    const previousId = await page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun()?.id ?? null);
    await propose();
    await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun()?.id ?? null)).not.toBe(previousId);
    await expect(page.locator(".cc-build-view").getByRole("status")).toContainText("Ready");
  };
  await create();
  const first = await active();
  await page.evaluate(async (run) => {
    const { vault } = (window as unknown as AppWindow).app;
    await vault.append(vault.getAbstractFileByPath(run.specPath), "\n## Acceptance notes\nKeep these spec notes.\n");
    await vault.append(vault.getAbstractFileByPath(run.trackerPath), "\n## Run notes\nKeep these tracker notes.\n");
    await vault.modify(vault.getAbstractFileByPath("Build plan.md"), "# Build plan\n\n- [ ] Revised task\n");
  }, first);
  const originalSpec = await read(first.specPath);
  const originalTracker = await read(first.trackerPath);
  await propose();
  await page.locator(".modal").getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await active()).id).toBe(first.id);
  await create();
  const second = await active();
  expect(second.id).not.toBe(first.id);
  expect(second.specPath).toBe("Claude/Builds/Build plan 2 — spec.md");
  expect(second.trackerPath).toBe("Claude/Builds/Build plan 2 — tracker.md");
  expect(await read(first.specPath)).toBe(originalSpec);
  expect(await read(first.trackerPath)).toBe(originalTracker);
  expect(await read(second.specPath)).toContain("Revised task");
  const runner = page.locator(".cc-build-view");
  await runner.getByRole("button", { name: "Start build", exact: true }).click();
  await expect(runner.getByRole("status")).toContainText("Build complete", { timeout: 15000 });
  await expect.poll(() => read(second.trackerPath)).toContain("**Status:** Complete");
  expect(await read(first.specPath)).toBe(originalSpec);
  expect(await read(first.trackerPath)).toBe(originalTracker);
  await page.screenshot({ path: testInfo.outputPath("second-build-preserves-original-documents.png"), animations: "disabled" });
  await rig.reloadPlugin();
  const runs = await page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!._build.serializeState().buildRuns.map(({ id, specPath, trackerPath, status }) => ({ id, specPath, trackerPath, status })));
  expect(runs).toEqual([first, { ...second, status: "completed" }]);
  expect(await read(first.specPath)).toBe(originalSpec);
  expect(await read(first.trackerPath)).toBe(originalTracker);
  expect((await active()).id).toBe(second.id);
  await runner.getByRole("button", { name: "Open spec", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(second.specPath);
  await runner.getByRole("button", { name: "Open tracker note", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(second.trackerPath);
  expect(errors).toEqual([]);
});
