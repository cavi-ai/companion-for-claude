import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const frontmatter = (markdown: string) => parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)![1]!) as Record<string, unknown>;

test("a manual passage without a location is checked through the guided form", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ providerReply: [{ match: "/./", replies: ['{"passages":[]}'] }] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(async () => {
    const app = (window as unknown as { app: {
      plugins: { plugins: Record<string, { research(): { researchRepository(): { importSource(project: string, input: unknown): Promise<unknown> } } }> };
      commands: { executeCommandById(id: string): Promise<void> };
    } }).app;
    await app.plugins.plugins["claude-companion"]!.research().researchRepository().importSource("Research/Beta/Project.md", { title: "Location source", sourceKind: "vault", capturedContent: "Traceable work needs a source location." });
    await app.commands.executeCommandById("claude-companion:open-research-desk");
  });
  const desk = page.locator(".cc-research-desk");
  await desk.getByLabel("Active research project").selectOption("Research/Beta/Project.md");
  await desk.getByRole("button", { name: "Pull passages", exact: true }).click();
  const modal = page.locator(".modal");
  await modal.getByLabel("Your passage", { exact: true }).fill("Traceable work needs a source location.");
  await modal.getByLabel("Passage title", { exact: true }).fill("Located draft");
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(desk.locator(".cc-desk-fix")).toHaveCount(0);
  const check = desk.locator(".cc-desk-step").filter({ hasText: 'Check "Located draft"' });
  await expect(check).toBeVisible();
  const path = join(rig.paths.vault, "Research/Beta/Evidence/Located draft.md");
  const proposed = await readFile(path, "utf8");
  expect(frontmatter(proposed).review_state).toBe("proposed");
  await desk.screenshot({ path: testInfo.outputPath("unlocated-passage-offers-guided-check.png") });
  await check.click();
  await expect(modal.getByRole("heading", { name: "Check Located draft", exact: true })).toBeVisible();
  await modal.getByLabel("Evidence interpretation").fill("Reviewed against the captured source.");
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Add a page, section, or other location");
  expect(await readFile(path, "utf8")).toBe(proposed);
  await modal.getByLabel("Locator type").selectOption("paragraph");
  await modal.getByLabel("Locator value").fill("1");
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(desk.locator(".cc-desk-fix")).toHaveCount(0);
  await expect(desk.locator(".cc-desk-step").filter({ hasText: 'Check "Located draft"' })).toHaveCount(0);
  const reviewed = await readFile(path, "utf8");
  expect(frontmatter(reviewed)).toMatchObject({ review_state: "reviewed", locator_kind: "paragraph", locator_value: "1" });
  expect(errors).toEqual([]);
});
