import { expect, test } from "./fixtures";

type AppWindow = { app: {
  vault: { create(path: string, body: string): Promise<unknown>; getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
  commands: { executeCommandById(id: string): void };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): { id: string; specPath: string; trackerPath: string; status: string; tasks: { title: string; status: string }[] } } }> };
} };

test("build extraction keeps examples in the plan while excluding them from executable tasks", async ({ rig }, testInfo) => {
  const { page } = await rig.reset();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cases = [
    { name: "Formatter plan", body: "# Formatter plan\n\n- [ ] Ship the formatter\n\n## Example output\n\n```markdown\n- [ ] Example checklist item\n```\n", task: "Ship the formatter" },
    { name: "Numbered plan", body: "1. Ship the milestone\n\n~~~markdown\n- [ ] Example checklist item\n~~~\n", task: "Ship the milestone" },
  ];
  const begin = async (name: string, body: string) => {
    await page.evaluate(async (note) => { const app = (window as unknown as AppWindow).app; await app.vault.create(`${note.name}.md`, note.body); await app.workspace.openLinkText(note.name, "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); }, { name, body });
  };
  const current = () => page.evaluate(() => {
    const run = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
    return { id: run.id, specPath: run.specPath, trackerPath: run.trackerPath, status: run.status, tasks: run.tasks };
  });
  const read = (path: string) => page.evaluate(async (value) => { const app = (window as unknown as AppWindow).app; return app.vault.read(app.vault.getAbstractFileByPath(value)); }, path);
  for (const note of cases) {
    await begin(note.name, note.body);
    await expect(page.locator(".modal")).toContainText(`Detected 1 task in "${note.name}"`);
    await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
    const runner = page.locator(".cc-build-view");
    await expect(runner.locator("h2")).toHaveText(note.name);
    await expect(runner.locator(".cc-build-task")).toHaveCount(1);
    await expect(runner.locator(".cc-build-task")).toContainText(note.task);
    const run = await current();
    expect(run.status).toBe("ready");
    expect(run.tasks).toEqual([{ title: note.task, status: "pending" }]);
    expect(await read(run.specPath)).toContain(note.body.trim());
    expect(await read(run.trackerPath)).not.toContain("Example checklist item");
    await page.screenshot({ path: testInfo.outputPath(`${note.name}-actual-tasks-only.png`), animations: "disabled" });
  }
  const before = await current();
  await begin("Examples only", "```markdown\n- [ ] Example checklist item\n```\n");
  await expect(page.locator(".notice").filter({ hasText: "no task checklist" })).toBeVisible();
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(await current()).toEqual(before);
  expect(await rig.providerRequests()).toBe(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("example-only-note-does-not-create-build.png"), animations: "disabled" });
});
