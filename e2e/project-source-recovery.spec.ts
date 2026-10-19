import { expect, test } from "./fixtures";
import type { App, TFile } from "obsidian";

type AppWindow = Window & { app: App & { commands: { executeCommandById(id: string): Promise<void> }; plugins: { plugins: Record<string, { lastMarkdownFile: TFile | null }> } }; originalSeedCreate?: App["vault"]["create"]; releaseSeedSave?: () => void };
const projectPath = "Research/Incident notes/Project.md";
const sourcePath = "Research/Incident notes/Sources/Incident notes.md";
const note = "# Incident notes\n\n" + "The archive records how notifications interrupt engineers during incident response. ".repeat(8);

for (const action of ["retry", "open", "close"] as const) {
  test(`a failed initial source save supports ${action} without recreating the project`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ extraFiles: { "Incident notes.md": note }, providerReply: [{ match: "/./", replies: ["How do notifications affect incident response?"] }] });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(async () => {
      const app = (window as unknown as AppWindow).app;
      app.plugins.plugins["claude-companion"]!.lastMarkdownFile = null;
      await app.workspace.openLinkText("Incident notes.md", "", false);
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.lastMarkdownFile?.path)).toBe("Incident notes.md");
    await page.evaluate(async () => { await (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:open-research-desk"); });
    await page.locator(".cc-research-desk").getByRole("button", { name: "From active note", exact: true }).click();
    const create = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Create research project", exact: true }) });
    await expect(create).toBeVisible();
    await page.evaluate((path) => {
      const w = window as unknown as AppWindow;
      w.originalSeedCreate = w.app.vault.create;
      w.app.vault.create = async function (...args) {
        if (args[0] === path) throw new Error("Source write unavailable");
        return w.originalSeedCreate!.apply(this, args);
      };
    }, sourcePath);
    const restore = () => page.evaluate(() => {
      const w = window as unknown as AppWindow;
      if (w.originalSeedCreate) w.app.vault.create = w.originalSeedCreate;
      delete w.originalSeedCreate;
      w.releaseSeedSave?.();
      delete w.releaseSeedSave;
    });
    try {
      await create.getByRole("button", { name: "Create project", exact: true }).click();
      const recovery = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Project created", exact: true }) });
      await expect(recovery).toBeVisible();
      await expect(create).toHaveCount(0);
      await expect(recovery.getByRole("alert")).toContainText("Source write unavailable");
      const savedProject = await page.evaluate(async (path) => { const app = (window as unknown as AppWindow).app; return app.vault.read(app.vault.getAbstractFileByPath(path) as TFile); }, projectPath);
      await recovery.screenshot({ path: testInfo.outputPath("created-project-with-source-recovery.png") });
      if (action === "open") {
        await recovery.getByRole("button", { name: "Open project", exact: true }).click();
      } else if (action === "retry") {
        await recovery.getByRole("button", { name: "Retry adding source", exact: true }).click();
        await expect(recovery.getByRole("alert")).toContainText("Source write unavailable");
        await expect(recovery.getByRole("status")).toHaveText("");
        await restore();
        await recovery.getByRole("button", { name: "Retry adding source", exact: true }).click();
      } else {
        await page.evaluate((path) => {
          const w = window as unknown as AppWindow;
          w.app.vault.create = async function (...args) {
            if (args[0] === path) await new Promise<void>(resolve => { w.releaseSeedSave = resolve; });
            return w.originalSeedCreate!.apply(this, args);
          };
        }, sourcePath);
        await recovery.getByRole("button", { name: "Retry adding source", exact: true }).click();
        await expect(recovery.getByRole("status")).toHaveText("Adding source…");
        await expect(recovery.getByRole("button", { name: "Retry adding source", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await page.locator(".cc-research-desk").getByLabel("Active research project").selectOption("Research/Beta/Project.md");
        await page.evaluate(() => { (window as unknown as AppWindow).releaseSeedSave!(); });
        await expect.poll(() => page.evaluate((path) => Boolean((window as unknown as AppWindow).app.vault.getAbstractFileByPath(path)), sourcePath)).toBe(true);
      }
      await expect(recovery).toHaveCount(0);
      await expect(page.locator(".cc-research-desk").getByLabel("Active research project")).toHaveValue(action === "close" ? "Research/Beta/Project.md" : projectPath);
      const state = await page.evaluate(async ({ projectPath, sourcePath }) => {
        const app = (window as unknown as AppWindow).app;
        const project = app.vault.getAbstractFileByPath(projectPath) as TFile;
        const source = app.vault.getAbstractFileByPath(sourcePath) as TFile | null;
        return { project: await app.vault.read(project), source: source ? await app.vault.read(source) : null, projects: app.vault.getMarkdownFiles().filter(file => file.path.startsWith("Research/Incident notes/") && file.name === "Project.md").length };
      }, { projectPath, sourcePath });
      expect(state.project).toBe(savedProject);
      expect(state.projects).toBe(1);
      if (action === "open") expect(state.source).toBeNull();
      else expect(state.source).toContain("The archive records how notifications interrupt engineers");
      expect(await rig.providerRequests()).toBe(1);
      expect(errors).toEqual([]);
    } finally { await restore(); }
  });
}
