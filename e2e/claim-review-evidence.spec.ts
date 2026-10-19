import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("claim review explains stale evidence and opens the passage for re-checking", async ({ rig }, testInfo) => {
  const { page } = await rig.reset({ settingsOverride: { agentModeEnabled: false } });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk");
  });
  const desk = page.locator(".cc-research-desk");
  const card = desk.locator(".cc-desk-card").filter({ hasText: "Continuity claim" });
  await card.locator(".cc-desk-card-head").click();
  await card.getByRole("button", { name: "Check claim", exact: true }).click();
  const modal = page.locator(".modal-container").last();
  await expect(modal.getByText("Continuity study · page 4", { exact: true })).toBeVisible();
  await expect(modal.getByText("The source changed. Re-check this passage before relying on it.", { exact: true })).toBeVisible();
  await expect(modal.getByText("This passage is not marked reviewed.", { exact: true })).toBeVisible();
  await expect(modal.getByText("Marking this claim reviewed does not check its passages.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("claim-review-with-evidence-warnings.png") });
  await modal.getByLabel("Add another limitation", { exact: true }).fill("Keep this limitation until I decide.");
  await modal.getByRole("button", { name: "Check passage: Stale result", exact: true }).click();
  await page.locator(".modal-container").last().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal.getByLabel("Add another limitation", { exact: true })).toHaveValue("Keep this limitation until I decide.");
  await modal.getByRole("button", { name: "Check passage: Stale result", exact: true }).click();
  await page.locator(".modal-container").last().getByRole("button", { name: "Discard and check", exact: true }).click();
  const evidence = page.locator(".modal-container").last();
  await expect(evidence.getByRole("heading", { name: "Check Stale result", exact: true })).toBeVisible();
  await expect(evidence.getByText("The source changed since this was checked. Confirm the passage still says this.", { exact: true })).toBeVisible();
  await expect(evidence.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
  const claim = await readFile(join(rig.paths.vault, "Research/Alpha/Claims/Continuity claim.md"), "utf8");
  expect(claim).toContain('review_state: reviewed');
  const passage = await readFile(join(rig.paths.vault, "Research/Alpha/Evidence/Stale result.md"), "utf8");
  expect(passage).toContain('source_fingerprint: "sha256:old"');
});

test("claim review shows saved limitations and adds to them without replacing them", async ({ rig }, testInfo) => {
  const { page } = await rig.reset();
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk");
  });
  const card = page.locator(".cc-research-desk .cc-desk-card").filter({ hasText: "Continuity claim" });
  await card.locator(".cc-desk-card-head").click();
  await card.getByRole("button", { name: "Check claim", exact: true }).click();
  const modal = page.locator(".modal-container").last();
  const limitations = modal.getByRole("region", { name: "Saved limitations", exact: true });
  await expect(limitations.getByRole("listitem")).toHaveText(["One workflow was studied"]);
  const addition = modal.getByLabel("Add another limitation", { exact: true });
  await expect(addition).toHaveValue("");
  await addition.fill("Only desktop workflows were studied.");
  await modal.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(modal).toBeHidden();
  await card.getByRole("button", { name: "Check claim", exact: true }).click();
  await expect(limitations.getByRole("listitem")).toHaveText(["One workflow was studied", "Only desktop workflows were studied."]);
  await expect(addition).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("saved-claim-limitations.png") });
});

test("unsupported claims guide stale support candidates through re-checking before linking", async ({ rig }, testInfo) => {
  const note = (title: string, fingerprint: string) => `---\ntitle: ${title}\ntype: evidence\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nsource_fingerprint: ${fingerprint}\nreview_state: reviewed\nlocator_kind: page\nlocator_value: 9\n---\n\n> Captured study.\n\nInterpretation: A prior reading.\n`;
  const { page } = await rig.reset({ extraFiles: {
    "Research/Alpha/Evidence/Earlier follow-up.md": note("Earlier follow-up", "sha256:old"),
    "Research/Alpha/Evidence/Current follow-up.md": note("Current follow-up", "sha256:new"),
    "Unrelated.md": "---\ninvalid: [\n---\n",
  } });
  await page.evaluate(async () => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk");
  });
  const card = page.locator(".cc-research-desk .cc-desk-card").filter({ hasText: "Continuity claim" });
  await card.locator(".cc-desk-card-head").click();
  await card.getByRole("button", { name: "Check claim", exact: true }).click();
  const modal = page.locator(".modal-container").last();
  await expect(modal.getByLabel("Link Earlier follow-up", { exact: true })).toBeDisabled();
  await expect(modal.getByLabel("Link Current follow-up", { exact: true })).toBeEnabled();
  const earlier = modal.locator(".cc-research-claim-evidence").filter({ hasText: "Earlier follow-up" });
  await expect(earlier).toContainText("Continuity study · page 9");
  await expect(earlier).toContainText("The source changed. Re-check this passage before relying on it.");
  await expect(earlier).toContainText("Check this passage before linking it as current support.");
  await earlier.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("candidate-passage-warnings.png") });
  await earlier.getByRole("button", { name: "Check passage: Earlier follow-up", exact: true }).click();
  await expect(modal.getByRole("heading", { name: "Check Earlier follow-up", exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal).toBeHidden();
  await card.getByRole("button", { name: "Check claim", exact: true }).click();
  await modal.getByLabel("Link Earlier follow-up", { exact: true }).check();
  await modal.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(card.locator(".cc-desk-chip")).toHaveText("Thin");
  const saved = await readFile(join(rig.paths.vault, "Research/Alpha/Claims/Continuity claim.md"), "utf8");
  expect(saved).toContain("[[Research/Alpha/Evidence/Earlier follow-up.md]]");
});
