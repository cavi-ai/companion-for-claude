import { expect, test } from "./fixtures";

type AppWindow = { app: {
  vault: { create(path: string, body: string): Promise<unknown> };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>; getActiveFile(): { path: string } | null };
  commands: { executeCommandById(id: string): void };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): { id: string; title: string; specPath: string } } }> };
} };

test("saved builds keep their own selection, documents and execution controls", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ fakeClaudeCode: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const runner = page.locator(".cc-build-view");
  const picker = runner.getByRole("combobox", { name: "Saved build", exact: true });
  const active = () => page.evaluate(() => {
    const run = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
    return { id: run.id, title: run.title, specPath: run.specPath };
  });
  const create = async (name: string) => {
    await page.evaluate(async (path) => { const app = (window as unknown as AppWindow).app; await app.workspace.openLinkText(path, "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); }, name);
    await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
    await expect(runner.locator("h2")).toHaveText(name);
    return active();
  };
  await page.evaluate(async () => { await (window as unknown as AppWindow).app.vault.create("Other project.md", "- [ ] Complete other project"); });
  const first = await create("Build plan");
  await runner.getByRole("button", { name: "Start build", exact: true }).click();
  await runner.getByRole("button", { name: "Pause after current task", exact: true }).click();
  await expect(runner.getByRole("status")).toContainText("Build paused", { timeout: 15000 });
  const second = await create("Other project");
  await expect(picker.locator("option")).toHaveCount(2);
  await picker.selectOption(first.id);
  await expect(runner.getByRole("button", { name: "Resume build", exact: true })).toBeVisible();
  await expect(runner.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await runner.getByRole("button", { name: "Open spec", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(first.specPath);
  await rig.reloadPlugin();
  await expect(picker).toHaveValue(first.id);
  await expect(runner.getByRole("status")).toContainText("Build paused");
  await page.screenshot({ path: testInfo.outputPath("earlier-build-selected-after-reload.png"), animations: "disabled" });

  await runner.getByRole("button", { name: "Resume build", exact: true }).click();
  await picker.selectOption(second.id);
  await expect(picker).toHaveValue(second.id);
  await expect(picker.locator(`option[value="${first.id}"]`)).toContainText("Build complete", { timeout: 15000 });
  await expect(runner.locator("h2")).toHaveText("Other project");
  await expect(runner.getByRole("status")).toContainText("Ready");
  expect((await active()).id).toBe(second.id);
  await runner.getByRole("button", { name: "Start build", exact: true }).click();
  await runner.getByRole("button", { name: "Cancel build", exact: true }).click();
  await expect(runner.getByRole("status")).toContainText("Build cancelled");
  await picker.selectOption(first.id);
  await expect(runner.getByRole("status")).toContainText("Build complete");
  await expect(runner.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await page.screenshot({ path: testInfo.outputPath("earlier-build-resumed-and-completed.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});
