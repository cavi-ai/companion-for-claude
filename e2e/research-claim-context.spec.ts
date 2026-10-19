import { expect, test } from "./fixtures";

test("new claims show the source location and trust warning before evidence is selected", async ({ rig }, testInfo) => {
  const reply = JSON.stringify({ title: "Suggested claim", proposition: "Continuity improves with provenance.", confidence: "moderate", relations: [{ evidence: "Research/Alpha/Evidence/Stale result.md", relation: "supports" }] });
  const { page } = await rig.reset({ providerReply: [{ match: "/./", replies: [reply] }] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk");
  });
  const desk = page.locator(".cc-research-desk");
  await desk.getByLabel("Active research project").selectOption("Research/Alpha/Project.md");
  await desk.getByRole("button", { name: "New claim", exact: true }).click();
  const modal = page.locator(".modal");
  const row = modal.locator(".cc-research-claim-evidence");
  await expect(row).toContainText("Stale result");
  await expect(row).toContainText("Continuity study · page 4");
  await expect(row).toContainText("The source changed. Re-check this passage before relying on it.");
  await modal.screenshot({ path: testInfo.outputPath("stale-source-warning-before-claim-creation.png") });
  await modal.getByLabel("Short title", { exact: true }).fill("Claim with stale support");
  await modal.getByLabel("Claim", { exact: true }).fill("Continuity requires checked source support.");
  await modal.getByLabel("Stale result supports", { exact: true }).check();
  await modal.getByRole("button", { name: "Create claim", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(desk.locator(".cc-desk-card", { hasText: "Claim with stale support" }).locator(".cc-desk-chip")).toHaveText("Unsupported");
  const saved = await page.evaluate(async () => {
    const repository = (window as unknown as { app: { plugins: { plugins: Record<string, { research(): { researchRepository(): { loadProject(path: string): Promise<{ claims: Array<{ title: string; trustedSupportCount: number; supports: string[]; reviewState: string }> }> } } }> } } }).app.plugins.plugins["claude-companion"]!.research().researchRepository();
    return (await repository.loadProject("Research/Alpha/Project.md")).claims.find(({ title }) => title === "Claim with stale support");
  });
  expect(saved).toMatchObject({ trustedSupportCount: 0, supports: ["Research/Alpha/Evidence/Stale result.md"], reviewState: "reviewed" });
  await desk.getByLabel("Active research project").selectOption("Research/Gamma/Project.md");
  await desk.getByRole("button", { name: "New claim", exact: true }).click();
  await expect(row).toContainText("Gamma study · page 2");
  await expect(row).toContainText("Checked passage.");
  await expect(row).not.toContainText("The source changed.");
  await modal.screenshot({ path: testInfo.outputPath("checked-source-context-before-claim-creation.png") });
  expect(errors).toEqual([]);
});
