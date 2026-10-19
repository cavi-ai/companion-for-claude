import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const generated = "Does task switching reduce output for remote engineers?";
const edited = "How does notification batching affect senior engineers during incident response?";
type AppWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  vault: { getMarkdownFiles(): Array<{ path: string; name: string }>; read(file: { path: string }): Promise<string> };
} };
async function openProject(page: Page) {
  await page.evaluate(async () => { await (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:open-research-desk"); });
  await page.locator(".cc-research-desk").getByLabel("Active research project").selectOption("__new__");
  const modal = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Create research project", exact: true }) });
  const question = modal.getByLabel("Research question", { exact: true });
  await question.fill("Does task switching affect output?");
  await modal.getByLabel("Project title", { exact: true }).fill("Incident response research");
  return { modal, question, draft: modal.getByRole("button", { name: "Draft a sharp research question with Claude from the title", exact: true }) };
}

for (const choice of ["keep", "use"] as const) {
  test(`research question edits survive generation and save the ${choice === "keep" ? "edited" : "explicitly chosen"} question`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({ providerDelayMs: 1200, providerReply: [{ match: "/./", replies: [generated] }] });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const { modal, question, draft } = await openProject(page);
    await draft.click();
    await expect(draft).toBeDisabled();
    await expect.poll(() => rig.providerRequests()).toBe(1);
    await question.fill(edited);
    await expect(draft).toBeEnabled();
    await expect(question).toHaveValue(edited);
    const suggestion = modal.getByRole("region", { name: "Suggested research question" });
    await expect(suggestion).toContainText(generated);
    await modal.screenshot({ path: testInfo.outputPath("edited-question-with-generated-suggestion.png") });
    await suggestion.getByRole("button", { name: choice === "keep" ? "Dismiss suggestion" : "Use suggested question", exact: true }).click();
    const expected = choice === "keep" ? edited : generated;
    await expect(question).toHaveValue(expected);
    await expect(suggestion).toHaveCount(0);
    await modal.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(modal).toHaveCount(0);
    const saved = await page.evaluate(async () => {
      const app = (window as unknown as AppWindow).app;
      const file = app.vault.getMarkdownFiles().find(file => file.path.startsWith("Research/Incident response research/") && file.name === "Project.md");
      return file ? app.vault.read(file) : null;
    });
    expect(saved).toContain(expected);
    expect(saved).not.toContain(choice === "keep" ? generated : edited);
    expect(errors).toEqual([]);
  });
}

test("an untouched research question receives its requested draft", async ({ rig }) => {
  const { page } = await rig.reset({ providerReply: [{ match: "/./", replies: [generated] }] });
  const { modal, question, draft } = await openProject(page);
  await draft.click();
  await expect(question).toHaveValue(generated);
  await expect(modal.getByRole("region", { name: "Suggested research question" })).toHaveCount(0);
});
