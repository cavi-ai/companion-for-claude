import { expect, test } from "./fixtures";
import type { Rig } from "./fixtures";

const project = "Research/Beta/Project.md";
const parserSource = "Research/Beta/Sources/Parser source.md";
const gammaSource = "Research/Beta/Sources/Gamma source.md";

async function openExtraction(rig: Rig, reply: string, fail = false) {
  const { page } = await rig.reset({ providerReply: [{ match: "/./", replies: [reply] }], ...(fail ? { providerFail: [{ match: "/./", status: 503 }] } : {}) });
  await page.evaluate(async (project) => {
    const app = (window as unknown as { app: {
      plugins: { plugins: Record<string, { research(): { researchRepository(): { importSource(project: string, input: unknown): Promise<unknown> } } }> };
      commands: { executeCommandById(id: string): Promise<void> };
    } }).app;
    const repository = app.plugins.plugins["claude-companion"]!.research().researchRepository();
    await repository.importSource(project, { title: "Parser source", sourceKind: "vault", capturedContent: "Create the parser." });
    await repository.importSource(project, { title: "Gamma source", sourceKind: "vault", capturedContent: "Gamma preserves continuity." });
    await app.commands.executeCommandById("claude-companion:open-research-desk");
  }, project);
  const desk = page.locator(".cc-research-desk");
  await desk.getByLabel("Active research project").selectOption(project);
  await desk.getByRole("button", { name: "Pull passages", exact: true }).click();
  const modal = page.locator(".modal");
  await modal.getByLabel("Source", { exact: true }).selectOption(parserSource);
  return { page, desk, modal, source: modal.getByLabel("Source", { exact: true }) };
}

async function evidence(rig: Rig) {
  return rig.page.evaluate(async (project) => {
    const repository = (window as unknown as { app: { plugins: { plugins: Record<string, { research(): { researchRepository(): { loadProject(project: string): Promise<{ evidence: Array<{ source: string; excerpt: string; title: string; locatorKind?: string; locatorValue?: string; interpretation?: string }> }> } } }> } } }).app.plugins.plugins["claude-companion"]!.research().researchRepository();
    return (await repository.loadProject(project)).evidence;
  }, project);
}

test("manual passage drafts remain with their sources through navigation and separate saves", async ({ rig }, testInfo) => {
  const { page, modal, source } = await openExtraction(rig, JSON.stringify({ passages: [] }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(modal.locator(".cc-research-modal-status")).toHaveText("No new exact passages were found for this source. Add one yourself below.");
  await expect(modal.getByRole("alert")).toBeEmpty();
  await expect(modal.getByRole("button", { name: "Try reading again", exact: true })).toBeHidden();
  await modal.getByLabel("Your passage", { exact: true }).fill("Create the parser.");
  await modal.getByLabel("Passage title", { exact: true }).fill("Parser implementation");
  await modal.getByLabel("Where it is: type", { exact: true }).selectOption("paragraph");
  await modal.getByLabel("Where it is: value", { exact: true }).fill("1");
  await source.selectOption(gammaSource);
  await expect(modal.getByLabel("Your passage", { exact: true })).toHaveValue("");
  await expect(modal.getByLabel("Where it is: value", { exact: true })).toHaveValue("");
  await modal.getByLabel("Your passage", { exact: true }).fill("Gamma preserves continuity.");
  await modal.getByLabel("Passage title", { exact: true }).fill("Gamma result");
  await modal.getByLabel("Where it is: value", { exact: true }).fill("2");
  await source.selectOption(parserSource);
  await expect(modal.getByLabel("Your passage", { exact: true })).toHaveValue("Create the parser.");
  await expect(modal.getByLabel("Passage title", { exact: true })).toHaveValue("Parser implementation");
  await expect(modal.getByLabel("Where it is: type", { exact: true })).toHaveValue("paragraph");
  await expect(modal.getByLabel("Where it is: value", { exact: true })).toHaveValue("1");
  await modal.screenshot({ path: testInfo.outputPath("manual-passage-kept-with-source.png") });
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal.locator(".cc-research-modal-status")).toContainText("Added 1 passage.");
  expect(await evidence(rig)).toEqual([expect.objectContaining({ source: parserSource, title: "Parser implementation", excerpt: "Create the parser.", locatorKind: "paragraph", locatorValue: "1" })]);
  await source.selectOption(gammaSource);
  await expect(modal.getByLabel("Your passage", { exact: true })).toHaveValue("Gamma preserves continuity.");
  await expect(modal.getByLabel("Passage title", { exact: true })).toHaveValue("Gamma result");
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(await evidence(rig)).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: parserSource, excerpt: "Create the parser." }),
    expect.objectContaining({ source: gammaSource, excerpt: "Gamma preserves continuity." }),
  ]));
  expect(await rig.providerRequests()).toBe(2);
  expect(errors).toEqual([]);
});

test("candidate edits and exclusions survive switching sources without another extraction request", async ({ rig }, testInfo) => {
  const reply = JSON.stringify({ passages: [{ title: "Parser candidate", excerpt: "Create the parser.", interpretation: "Original parser reading." }, { title: "Gamma candidate", excerpt: "Gamma preserves continuity.", interpretation: "Original Gamma reading." }] });
  const { page, modal, source } = await openExtraction(rig, reply);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const card = modal.locator(".cc-research-passage-card");
  await card.getByLabel("Passage title", { exact: true }).fill("Reviewed parser title");
  await card.getByLabel("What this passage shows", { exact: true }).fill("My unfinished interpretation.");
  await card.getByRole("checkbox").uncheck();
  await source.selectOption(gammaSource);
  await card.getByLabel("Passage title", { exact: true }).fill("Reviewed Gamma title");
  await source.selectOption(parserSource);
  await expect(card.getByLabel("Passage title", { exact: true })).toHaveValue("Reviewed parser title");
  await expect(card.getByLabel("What this passage shows", { exact: true })).toHaveValue("My unfinished interpretation.");
  await expect(card.getByRole("checkbox")).not.toBeChecked();
  expect(await rig.providerRequests()).toBe(2);
  await modal.screenshot({ path: testInfo.outputPath("candidate-edits-and-exclusion-preserved.png") });
  await card.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal.locator(".cc-research-modal-status")).toContainText("Added 1 passage.");
  await source.selectOption(gammaSource);
  await expect(card.getByLabel("Passage title", { exact: true })).toHaveValue("Reviewed Gamma title");
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(await evidence(rig)).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: parserSource, title: "Reviewed parser title", interpretation: "My unfinished interpretation." }),
    expect.objectContaining({ source: gammaSource, title: "Reviewed Gamma title" }),
  ]));
  expect(errors).toEqual([]);
});

test("a failed source read can be retried while preserving manual passage work", async ({ rig }, testInfo) => {
  const reply = JSON.stringify({ passages: [{ title: "Parser candidate", excerpt: "Create the parser." }] });
  const { page, modal } = await openExtraction(rig, reply, true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(modal.getByRole("alert")).toContainText("503");
  const manual = modal.locator(".cc-research-passage-manual");
  await manual.getByLabel("Your passage", { exact: true }).fill("Create the parser.");
  await manual.getByLabel("Passage title", { exact: true }).fill("My manual draft");
  await rig.control.setStubs({ providerReply: [{ match: "/./", replies: [reply] }] });
  await modal.getByRole("button", { name: "Try reading again", exact: true }).click();
  await expect(modal.locator(".cc-research-passage-card blockquote")).toHaveText("Create the parser.");
  await expect(manual.getByLabel("Your passage", { exact: true })).toHaveValue("Create the parser.");
  await expect(manual.getByLabel("Passage title", { exact: true })).toHaveValue("My manual draft");
  await expect(modal.getByRole("alert")).toBeEmpty();
  expect(await evidence(rig)).toEqual([]);
  await modal.screenshot({ path: testInfo.outputPath("failed-read-retried-with-draft-preserved.png") });
  expect(errors).toEqual([]);
});

test("unusable extraction data is retryable and does not report an empty successful result", async ({ rig }, testInfo) => {
  const { page, modal } = await openExtraction(rig, "not a passage list");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(modal.getByRole("alert")).toHaveText("The model did not return a valid passage list.");
  await expect(modal.locator(".cc-research-modal-status")).toContainText("Couldn't read this source automatically.");
  const manual = modal.locator(".cc-research-passage-manual");
  await manual.getByLabel("Your passage", { exact: true }).fill("Create the parser.");
  await manual.getByLabel("Passage title", { exact: true }).fill("Manual parser draft");
  await modal.screenshot({ path: testInfo.outputPath("unusable-response-with-retry.png") });
  const reply = JSON.stringify({ passages: [{ title: "Parser candidate", excerpt: "Create the parser." }] });
  await rig.control.setStubs({ providerReply: [{ match: "/./", replies: [reply] }] });
  await modal.getByRole("button", { name: "Try reading again", exact: true }).click();
  await expect(modal.locator(".cc-research-passage-card blockquote")).toHaveText("Create the parser.");
  await expect(manual.getByLabel("Your passage", { exact: true })).toHaveValue("Create the parser.");
  await expect(modal.getByRole("alert")).toBeEmpty();
  expect(await evidence(rig)).toEqual([]);
  await expect(modal.locator(".cc-research-duplicate-passage")).toContainText("matches a selected suggestion");
  await expect(modal.getByRole("button", { name: "Add 2 passages", exact: true })).toBeDisabled();
  await modal.screenshot({ path: testInfo.outputPath("matching-manual-and-suggested-passage.png") });
  await modal.locator(".cc-research-passage-card").getByRole("checkbox").uncheck();
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(await evidence(rig)).toEqual([expect.objectContaining({ source: parserSource, title: "Manual parser draft", excerpt: "Create the parser.", reviewState: "proposed" })]);
  expect(errors).toEqual([]);
});
