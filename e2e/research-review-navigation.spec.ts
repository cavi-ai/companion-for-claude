import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

for (const kind of ["claim", "passage"] as const) {
  test(`${kind} review opens its note without blocking it or losing unconfirmed edits`, async ({ rig }, testInfo) => {
    const passagePath = "Research/Alpha/Evidence/Stale result.md";
    const { page } = await rig.reset({ extraFiles: {
      [passagePath]: '---\ntitle: Stale result\ntype: evidence\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nsource_fingerprint: sha256:old\nlocator_kind: page\nlocator_value: 4\nreview_state: reviewed\n---\n\n> Captured study.\n\nInterpretation: Existing reading.\n',
    } });
    const path = kind === "claim" ? "Research/Alpha/Claims/Continuity claim.md" : passagePath;
    const original = await readFile(join(rig.paths.vault, path), "utf8");
    const openReview = async () => {
      await page.evaluate(async () => {
        await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk");
      });
      const desk = page.locator(".cc-research-desk");
      if (kind === "claim") {
        const card = desk.locator(".cc-desk-card").filter({ hasText: "Continuity claim" });
        if (await card.locator(".cc-desk-card-head").getAttribute("aria-expanded") !== "true") await card.locator(".cc-desk-card-head").click();
        await card.getByRole("button", { name: "Check claim", exact: true }).click();
      } else await desk.getByRole("button", { name: 'Re-check "Stale result"', exact: true }).click();
    };
    const modal = page.locator(".modal-container").last();
    await openReview();
    await modal.getByRole("button", { name: "Open note", exact: true }).click();
    await expect(page.locator(".modal-container")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { app: { workspace: { getActiveFile(): { path: string } | null } } }).app.workspace.getActiveFile()?.path)).toBe(path);
    await openReview();
    const input = modal.getByLabel(kind === "claim" ? "Add another limitation" : "Evidence interpretation", { exact: true });
    await input.fill("Keep this unfinished review.");
    await modal.getByRole("button", { name: "Open note", exact: true }).click();
    await page.locator(".modal-container").last().getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(input).toHaveValue("Keep this unfinished review.");
    expect(await readFile(join(rig.paths.vault, path), "utf8")).toBe(original);
    await modal.getByRole("button", { name: "Open note", exact: true }).click();
    await page.locator(".modal-container").last().getByRole("button", { name: "Discard and open", exact: true }).click();
    await expect(page.locator(".modal-container")).toHaveCount(0);
    const editor = page.locator(".markdown-source-view:visible .cm-content");
    await editor.click();
    await expect(editor).toBeFocused();
    expect(await readFile(join(rig.paths.vault, path), "utf8")).toBe(original);
    await page.screenshot({ path: testInfo.outputPath(`${kind}-note-open-and-accessible.png`) });
    await openReview();
    await page.evaluate(async (path) => {
      const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown; delete(file: unknown): Promise<void> } } }).app;
      await app.vault.delete(app.vault.getAbstractFileByPath(path));
    }, path);
    await modal.getByRole("button", { name: "Open note", exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("alert")).toHaveText(`Research note not found: ${path}`);
  });
}
