import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> };
  plugins: { plugins: Record<string, { research(): { activeBuildRun(): { id: string; status: string; trackerPath: string; tasks: { status: string }[] } } }> };
} };

for (const failure of [
  { name: "provider error", output: { type: "result", subtype: "success", is_error: true, result: "API Error: 503 provider unavailable" }, message: "provider unavailable" },
  { name: "turn limit", output: { type: "result", subtype: "error_max_turns", is_error: false }, message: "turn limit" },
  { name: "missing result", output: { type: "assistant", message: { content: [{ type: "text", text: "Working" }] } }, message: "without a task result" },
]) {
  test(`a ${failure.name} stops later build tasks and can be retried`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ fakeClaudeCode: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cli = join(dirname(rig.argvLog), "claude");
    const original = await readFile(cli, "utf8");
    const body = original.replace(/^#![^\n]*\n/, "");
    const logCall = 'printf "BUILD\\n" >> "$(dirname "$0")/claude-argv.log"';
    const failedCli = `#!/bin/sh\ncase "$1" in\n-p) ${logCall}; printf '%s\\n' '${JSON.stringify(failure.output)}'; exit 0 ;;\nesac\n${body}`;
    const workingCli = `#!/bin/sh\ncase "$1" in\n-p) ${logCall} ;;\nesac\n${body}`;
    try {
      await writeFile(cli, failedCli);
      await page.evaluate(async () => { const app = (window as unknown as AppWindow).app; await app.workspace.openLinkText("Build plan", "", false); app.commands.executeCommandById("claude-companion:build-from-plan"); });
      await page.locator(".modal").getByRole("button", { name: "Create build", exact: true }).click();
      const runner = page.locator(".cc-build-view");
      await runner.getByRole("button", { name: "Start build", exact: true }).click();
      await expect(runner.getByRole("status")).toContainText("Build needs attention");
      await expect(runner.getByRole("alert")).toContainText(failure.message);
      await expect(runner.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
      const run = await page.evaluate(() => {
        const run = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun();
        return { id: run.id, trackerPath: run.trackerPath, tasks: run.tasks };
      });
      expect(run.tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
      expect((await readFile(rig.argvLog, "utf8")).split("\n").filter((line) => line === "BUILD")).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath("structured-failure-stops-build.png"), animations: "disabled" });
      await rig.reloadPlugin();
      await expect(runner.getByRole("alert")).toContainText(failure.message);
      await writeFile(cli, workingCli);
      await runner.getByRole("button", { name: "Retry task", exact: true }).click();
      await expect(runner.getByRole("status")).toContainText("Build complete", { timeout: 15000 });
      await expect(runner.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
      expect((await readFile(rig.argvLog, "utf8")).split("\n").filter((line) => line === "BUILD")).toHaveLength(3);
      expect(await page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.research().activeBuildRun().id)).toBe(run.id);
      const tracker = await page.evaluate(async (path) => { const app = (window as unknown as AppWindow).app; return app.vault.read(app.vault.getAbstractFileByPath(path)); }, run.trackerPath);
      expect(tracker).toContain("**Status:** Complete");
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("retry-completes-build.png"), animations: "disabled" });
    } finally {
      await writeFile(cli, original);
    }
  });
}
