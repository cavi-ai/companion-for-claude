import { expect, test } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

test("Build creates documents and runs tasks in native stable controls without copy-paste", async ({}, testInfo) => {
  const harness = await launchObsidianHarness({ fakeClaudeCode: true });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: {
        vault: { getAbstractFileByPath(path: string): unknown };
        workspace: { getLeaf(openNew: boolean): { openFile(file: unknown): Promise<void> } };
        commands: { executeCommandById(id: string): Promise<void> };
      } }).app;
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Build plan.md"));
      await app.commands.executeCommandById("claude-companion:build-from-plan");
    });
    const modal = page.locator(".modal-container").filter({ hasText: "Build from this plan?" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Create build" }).click();

    const runner = page.locator(".cc-build-view");
    await expect(runner).toBeVisible();
    await expect(runner.getByRole("status")).toContainText("Ready");
    await expect(runner.getByRole("button", { name: "Pause after current task" })).toBeHidden();
    await expect(runner.getByRole("button", { name: "Cancel build" })).toBeHidden();
    await expect(runner.getByRole("button", { name: "Open cloud session" })).toBeHidden();
    await expect(runner).not.toContainText("copy");
    await expect(runner).not.toContainText("terminal");
    expect(await runner.locator("[style]").count()).toBe(0);
    const styleElementCount = await page.locator("style").count();
    const progress = runner.getByRole("progressbar");
    const progressHandle = await progress.elementHandle();
    const readyBox = await runner.boundingBox();
    await page.screenshot({ path: testInfo.outputPath("build-runner-ready.png") });
    await page.evaluate(() => { document.body.classList.remove("theme-light"); document.body.classList.add("theme-dark"); });
    await runner.screenshot({ path: testInfo.outputPath("build-runner-ready-dark.png") });
    await page.evaluate(() => { document.body.classList.remove("theme-dark"); document.body.classList.add("theme-light"); });

    await runner.getByRole("button", { name: "Start build" }).click();
    await expect(runner.getByRole("status")).toContainText("Running task 1 of 2");
    await runner.getByRole("button", { name: "Pause after current task" }).click();
    await expect(runner.getByRole("status")).toContainText("Build paused", { timeout: 15_000 });
    await runner.screenshot({ path: testInfo.outputPath("build-runner-paused.png") });
    await runner.getByRole("button", { name: "Resume build" }).click();
    await expect(runner.getByRole("status")).toContainText("Build complete", { timeout: 15_000 });
    await expect(progress).toHaveAttribute("aria-valuenow", "100");
    await expect(runner.getByRole("button", { name: "Resume build" })).toBeHidden();
    await expect(runner.getByRole("button", { name: "Pause after current task" })).toBeHidden();
    await expect(runner.getByRole("button", { name: "Cancel build" })).toBeHidden();
    expect(await progressHandle?.evaluate((node) => node.isConnected && node.getAttribute("aria-valuenow") === "100")).toBe(true);
    expect(await runner.locator("[style]").count()).toBe(0);
    expect(await page.locator("style").count()).toBe(styleElementCount);
    const completeBox = await runner.boundingBox();
    expect(readyBox?.width).toBe(completeBox?.width);
    await page.screenshot({ path: testInfo.outputPath("build-runner-complete.png") });

    const files = await page.evaluate(() => {
      const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): { path?: string } | null } } }).app;
      return ["Claude/Builds/Build plan — spec.md", "Claude/Builds/Build plan — tracker.md"].map((path) => app.vault.getAbstractFileByPath(path)?.path ?? null);
    });
    expect(files).toEqual(["Claude/Builds/Build plan — spec.md", "Claude/Builds/Build plan — tracker.md"]);
  } finally {
    await harness.close();
  }
});

test("Build Runner keeps controls inside a compact mobile viewport", async ({}, testInfo) => {
  const harness = await launchObsidianHarness({ fakeClaudeCode: true });
  const { page } = harness;
  try {
    await page.evaluate(() => window.resizeTo(390, 844));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(420);
    await page.evaluate(async () => {
      const app = (window as unknown as { app: {
        vault: { getAbstractFileByPath(path: string): unknown };
        workspace: { getLeaf(openNew: boolean): { openFile(file: unknown): Promise<void> } };
        commands: { executeCommandById(id: string): Promise<void> };
      } }).app;
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Build plan.md"));
      await app.commands.executeCommandById("claude-companion:build-from-plan");
    });
    const modal = page.locator(".modal-container").filter({ hasText: "Build from this plan?" });
    await modal.getByRole("button", { name: "Create build" }).click();
    const runner = page.locator(".cc-build-view");
    await expect(runner).toBeVisible();
    const box = await runner.boundingBox();
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(box?.width).toBeLessThanOrEqual(viewportWidth);
    expect(await runner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const startBox = await runner.getByRole("button", { name: "Start build" }).boundingBox();
    expect(startBox?.height).toBeGreaterThanOrEqual(44);
    await runner.screenshot({ path: testInfo.outputPath("build-runner-mobile-ready.png") });
  } finally {
    await harness.close();
  }
});
