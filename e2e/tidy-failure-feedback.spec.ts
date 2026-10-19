import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const ORIGINAL = "# Garden draft\n\nWater the plants in the morning.\n";
const CORRECTED = "# Garden draft\n\nWater the plants in the evening.\n";
type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> };
  plugins: { plugins: Record<string, { activity: { snapshot(): { records: Array<{ title: string; state: string; technicalDetails?: string }> } } }> };
} };

const read = (page: Page) => page.evaluate(() => { const { vault } = (window as unknown as AppWindow).app; return vault.read(vault.getAbstractFileByPath("Garden draft.md")); });
const activity = (page: Page) => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.activity.snapshot().records.filter(({ title }) => title.startsWith("Tidying")));
const openNote = (page: Page) => page.evaluate(() => (window as unknown as AppWindow).app.workspace.openLinkText("Garden draft", "", false));
async function tidy(page: Page, enabled: string[]) {
  await page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:enrich-note"));
  for (const name of ["Rename note", "Tags & summary", "Add wikilinks", "Lint note"]) {
    if (!enabled.includes(name)) await page.locator(".modal .setting-item").filter({ hasText: name }).locator(".checkbox-container").click();
  }
  await page.locator(".modal").getByRole("button", { name: "Tidy", exact: true }).click();
}

test("failed title and tag checks report incomplete work and can be retried", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ extraFiles: { "Garden draft.md": ORIGINAL }, providerFail: [{ match: "/./", status: 503 }] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openNote(page);
  await tidy(page, ["Rename note", "Tags & summary"]);
  const notice = page.locator(".notice").filter({ hasText: "Tidy couldn't finish Garden draft" });
  await expect(notice).toContainText("Rename note / Tags & summary");
  await expect(notice).toContainText("Run Tidy again to retry");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".notice").filter({ hasText: "already in good shape" })).toHaveCount(0);
  expect(await read(page)).toBe(ORIGINAL);
  expect(await activity(page)).toMatchObject([{ state: "needs-attention", technicalDetails: expect.stringContaining("Rename note / Tags & summary") }]);
  await page.screenshot({ path: testInfo.outputPath("failed-tidy-check.png"), animations: "disabled" });
  await rig.control.setStubs({ providerReply: [{ match: "/./", replies: ["TITLE: Garden schedule\nTAGS: gardening, watering\nSUMMARY: When to water garden plants."] }] });
  await tidy(page, ["Rename note", "Tags & summary"]);
  const modal = page.locator(".modal");
  await expect(modal.getByRole("alert")).toHaveCount(0);
  await modal.locator(".cc-organize-row").filter({ hasText: "Rename" }).getByRole("checkbox").uncheck();
  await modal.getByRole("button", { name: "Apply selected", exact: true }).click();
  await expect(page.locator(".notice").filter({ hasText: "Tidied Garden draft." })).toBeVisible();
  const content = await read(page);
  expect(content).toContain(ORIGINAL);
  expect(content).toContain("gardening");
  expect(content).toContain("When to water garden plants.");
  expect(errors).toEqual([]);
});

test("successful copyedits remain reviewable when tagging fails", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ extraFiles: { "Garden draft.md": ORIGINAL }, providerFail: [{ match: "precise knowledge-base indexer", status: 503 }], providerReply: [{ match: "meticulous markdown copyeditor", replies: [CORRECTED] }] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openNote(page);
  const modal = page.locator(".modal");
  await tidy(page, ["Rename note", "Tags & summary", "Lint note"]);
  await expect(modal.getByRole("alert")).toContainText("Some Tidy steps failed");
  await expect(modal.getByRole("alert")).toContainText("Rename note / Tags & summary");
  await expect(modal.locator(".cc-diff-hunk")).toHaveCount(1);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await read(page)).toBe(ORIGINAL);
  await tidy(page, ["Rename note", "Tags & summary", "Lint note"]);
  await expect(modal.getByRole("alert")).toContainText("Some Tidy steps failed");
  await page.screenshot({ path: testInfo.outputPath("partial-tidy-review.png"), animations: "disabled" });
  await modal.getByRole("button", { name: "Apply selected", exact: true }).click();
  await expect(page.locator(".notice").filter({ hasText: "Some Tidy steps failed; run Tidy again to retry" })).toBeVisible();
  expect(await read(page)).toBe(CORRECTED);
  expect((await activity(page)).every(({ state }) => state === "needs-attention")).toBe(true);
  await expect(page.locator(".notice").filter({ hasText: "Tidied Garden draft." })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const { label, reply, failed } of [{ label: "empty", reply: "   ", failed: true }, { label: "truncated", reply: "# Garden", failed: true }, { label: "unchanged", reply: ORIGINAL, failed: false }]) {
  test(`a ${label} copyedit reply has truthful completion feedback`, async ({ rig }) => {
    const { page } = await rig.reset({ extraFiles: { "Garden draft.md": ORIGINAL }, providerReply: [{ match: "/./", replies: [reply] }] });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openNote(page);
    await tidy(page, ["Lint note"]);
    await expect(page.locator(".notice").filter({ hasText: failed ? "Tidy couldn't finish Garden draft" : "Garden draft is already in good shape." })).toBeVisible();
    if (failed) await expect(page.locator(".notice").filter({ hasText: "already in good shape" })).toHaveCount(0);
    expect(await read(page)).toBe(ORIGINAL);
    expect(await activity(page)).toMatchObject([{ state: failed ? "needs-attention" : "succeeded" }]);
    expect(errors).toEqual([]);
  });
}
