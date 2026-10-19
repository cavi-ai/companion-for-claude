import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("keeping a passage requires a location and retains edits until corrected", async ({ rig }, testInfo) => {
  const path = "Research/Alpha/Evidence/Challenge.md";
  const original = '---\ntitle: "Challenge"\ntype: evidence\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nreview_state: proposed\n---\n\n> Captured study.\n\nInterpretation: Existing interpretation.\n';
  const { page } = await rig.reset({ extraFiles: { [path]: original } });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk");
  });
  const desk = page.locator(".cc-research-desk");
  await desk.getByRole("button", { name: 'Check "Challenge"', exact: true }).click();
  const modal = page.locator(".modal-container").last();
  const locator = modal.getByLabel("Locator value", { exact: true });
  const interpretation = modal.getByLabel("Evidence interpretation", { exact: true });
  await interpretation.fill("My reading stays here.");
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("alert")).toHaveText("Add a page, section, or other location before keeping this passage.");
  await expect(locator).toBeFocused();
  await expect(locator).toHaveAttribute("aria-invalid", "true");
  await expect(interpretation).toHaveValue("My reading stays here.");
  expect(await readFile(join(rig.paths.vault, path), "utf8")).toBe(original);
  await page.screenshot({ path: testInfo.outputPath("missing-location-with-edits-preserved.png") });
  await modal.getByLabel("Locator type", { exact: true }).selectOption("section");
  await locator.fill("Methods");
  await expect(locator).not.toHaveAttribute("aria-invalid", "true");
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal).toBeHidden();
  const saved = await readFile(join(rig.paths.vault, path), "utf8");
  expect(saved).toContain("locator_kind: section");
  expect(saved).toContain("locator_value: Methods");
  expect(saved).toContain("review_state: reviewed");
  expect(saved).toContain("Interpretation: My reading stays here.");
});
