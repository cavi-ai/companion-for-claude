import { expect, test } from "@playwright/test";
import { launchObsidianHarness, type ObsidianHarness } from "./obsidianHarness";

test.describe.configure({ mode: "serial" });
let harness: ObsidianHarness;
let consoleFailures: string[] = [];

test.beforeAll(async () => {
  harness = await launchObsidianHarness();
  harness.page.on("console", (message) => { if (message.type() === "error") consoleFailures.push(message.text()); });
  harness.page.on("pageerror", (error) => consoleFailures.push(error.message));
});
test.afterAll(async () => { await harness?.close(); });

test("01 launch: plugin loads without EPIPE or console failure", async () => {
  await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk"); });
  await expect(harness.page.locator(".cc-research-desk")).toBeVisible();
  await expect(harness.page.getByRole("heading", { name: "Continuity research" })).toBeVisible();
  expect(consoleFailures.filter((failure) => /EPIPE|claude-companion|unhandled/i.test(failure))).toEqual([]);
  await harness.page.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/01-desk.png" });
});

test("02 guidance: recommendation explains, pins, dismisses, and preserves the queue", async () => {
  const desk = harness.page.locator(".cc-research-desk");
  await expect(desk.locator(".cc-desk-next-reason")).toContainText("source changed");
  await desk.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(desk.locator(".cc-desk-next")).toHaveAttribute("data-pinned", "true");
  await desk.getByRole("button", { name: "Unpin", exact: true }).click();
  const firstTitle = await desk.locator(".cc-desk-next h3").textContent();
  await desk.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(desk.locator(".cc-desk-next h3")).not.toHaveText(firstTitle ?? "");
});

test("03 continuity: project switching and active-document state remain understandable", async () => {
  const desk = harness.page.locator(".cc-research-desk");
  await desk.getByLabel("Active research project").selectOption("Research/Beta/Project.md");
  await expect(desk.getByRole("heading", { name: "Empty project" })).toBeVisible();
  await expect(desk.locator(".cc-desk-next h3")).toContainText("first source");
  await desk.getByLabel("Active research project").selectOption("Research/Alpha/Project.md");
  await expect(desk.locator(".cc-desk-document")).toContainText("White paper");
});

test("04 handoff: every quick action opens the matching advanced capability", async () => {
  const mappings = [["Capture source", "Sources"], ["Review evidence", "Evidence"], ["Develop claim", "Claims"], ["Continue draft", "Draft"], ["Run audit", "Audit"]] as const;
  for (const [button, tab] of mappings) {
    await harness.page.locator(".cc-research-desk").getByRole("button", { name: button, exact: true }).click();
    const workbench = harness.page.locator(".cc-research-workbench"); await expect(workbench).toBeVisible(); await expect(workbench.locator(".cc-research-tab-select")).toHaveValue(tab);
    await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk"); });
    await expect(harness.page.locator(".cc-research-desk")).toBeVisible();
  }
});

test("05 advanced workbench: grouped navigation exposes every research panel without implicit network work", async () => {
  await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-workbench"); });
  const workbench = harness.page.locator(".cc-research-workbench");
  await expect(workbench.locator(".cc-research-tab-group")).toHaveCount(4);
  await expect(workbench.locator(".cc-research-header-top .cc-workspace-navigation")).toBeVisible();
  const before = harness.providerRequests();
  for (const tab of ["Overview", "Sources", "Evidence", "Claims", "Outline", "Draft", "Audit", "Intelligence", "Discover"]) {
    await workbench.locator(".cc-research-tab-select").selectOption(tab);
    await expect(workbench.getByRole("tabpanel")).toBeVisible();
    await expect(workbench.locator(".cc-research-panel-intro")).toBeVisible();
  }
  await expect(workbench.getByRole("heading", { name: "Scholarly discovery is off" })).toBeVisible();
  await expect(workbench.getByLabel("Discovery query")).toHaveCount(0);
  await expect(workbench.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
  await expect.poll(async () => await workbench.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(harness.providerRequests()).toBe(before);
  await harness.page.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/05-workbench.png" });

  for (const [tab, title, artifact] of [["Overview", "Project overview", "05a-overview"], ["Sources", "Source library", "05b-sources"], ["Evidence", "Evidence review", "05c-evidence"], ["Intelligence", "Research intelligence", "05d-intelligence"]] as const) {
    await workbench.locator(".cc-research-tab-select").selectOption(tab);
    await expect(workbench.locator(".cc-research-panel-title")).toHaveText(title);
    await expect(workbench.getByRole("heading", { name: "Continuity research" })).toBeVisible();
    await workbench.evaluate((element) => { element.scrollTop = 0; });
    await workbench.screenshot({ path: `/private/tmp/claude-companion-research-e2e-results/${artifact}.png` });
  }
});

test("06 native continuity: evidence becomes a claim and an outline without leaving the workbench", async () => {
  const mobileWidths = [320, 360, 390, 428, 768];
  const verifyModalWidths = async (modal: ReturnType<typeof harness.page.locator>, actionName: string, artifact: string) => {
    for (const width of mobileWidths) {
      await harness.page.setViewportSize({ width, height: 900 });
      await expect(modal).toBeVisible();
      await expect(modal.getByRole("button", { name: actionName, exact: true })).toBeVisible();
      await expect.poll(async () => await modal.locator(".modal-content").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await modal.screenshot({ path: `/private/tmp/claude-companion-research-e2e-results/${artifact}-${width}.png` });
    }
    await harness.page.setViewportSize({ width: 1440, height: 900 });
  };
  const workbench = harness.page.locator(".cc-research-workbench");
  await workbench.locator(".cc-research-tab-select").selectOption("Evidence");
  await workbench.getByRole("button", { name: "Review evidence", exact: true }).click();
  const review = harness.page.locator(".modal-container").last();
  await expect(review.getByRole("heading", { name: "Review Challenge" })).toBeVisible();
  await expect(review.locator(".cc-research-evidence-excerpt")).toContainText("Continuity varies by workflow");
  await verifyModalWidths(review, "Mark reviewed", "06a-review-evidence-mobile");
  await review.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/06a-review-evidence.png" });
  await review.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(review).toBeHidden();

  await workbench.locator(".cc-research-tab-select").selectOption("Claims");
  await workbench.getByRole("button", { name: "Create claim", exact: true }).click();
  const claim = harness.page.locator(".modal-container").last();
  await claim.getByLabel("Claim title").fill("Workflow continuity claim");
  await claim.getByLabel("Proposition").fill("Reviewed evidence preserves continuity across the workflow.");
  await claim.getByLabel("Challenge supports").check();
  await verifyModalWidths(claim, "Create claim", "06b-create-claim-mobile");
  await claim.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/06b-create-claim.png" });
  await claim.getByRole("button", { name: "Create claim", exact: true }).click();
  await expect(claim).toBeHidden();
  await expect(workbench.getByText("Workflow continuity claim", { exact: true })).toBeVisible();

  await workbench.locator(".cc-research-tab-select").selectOption("Outline");
  await workbench.getByRole("button", { name: "Build outline", exact: true }).click();
  const outline = harness.page.locator(".modal-container").last();
  await expect(outline.getByRole("heading", { name: "Build evidence-backed outline" })).toBeVisible();
  await expect(outline.getByLabel("Include Continuity claim")).toBeChecked();
  await verifyModalWidths(outline, "Build outline", "06c-build-outline-mobile");
  await outline.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/06c-build-outline.png" });
  await outline.getByRole("button", { name: "Build outline", exact: true }).click();
  await expect(outline).toBeHidden();
  await expect(harness.page.locator(".workspace-leaf-content[data-type='markdown']").last()).toContainText("Outline");
  expect(consoleFailures.filter((failure) => /EPIPE|unhandled/i.test(failure))).toEqual([]);
});

test("07 accessibility and responsive states: controls remain named and reachable", async () => {
  await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk"); });
  const desk = harness.page.locator(".cc-research-desk");
  await expect(desk.getByRole("button", { name: "Start this task" })).toBeVisible();
  await expect(desk.getByRole("progressbar", { name: "Grounded section progress" })).toHaveAttribute("aria-valuenow");
  await harness.page.setViewportSize({ width: 1440, height: 900 });
  for (const width of [320, 360, 390, 428, 768]) {
    await harness.page.locator(".workspace-split.mod-right-split").evaluate((element, paneWidth) => { (element as HTMLElement).style.width = `${paneWidth}px`; }, width);
    await expect(desk).toBeVisible();
    await expect.poll(async () => Math.round((await desk.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(width - 12);
    await expect.poll(async () => await desk.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await desk.evaluate((element) => { element.scrollTop = 0; });
    await desk.screenshot({ path: `/private/tmp/claude-companion-research-e2e-results/06-desk-${width}.png` });
  }
  expect(consoleFailures.filter((failure) => /EPIPE|unhandled/i.test(failure))).toEqual([]);
});

test("08 Companion continuity: active research becomes context, not a new home", async () => {
  await harness.page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown }; workspace: { getLeaf(value: boolean): { openFile(file: unknown): Promise<void> } }; commands: { executeCommandById(id: string): Promise<void> } } }).app;
    const project = app.vault.getAbstractFileByPath("Research/Alpha/Project.md");
    if (!project) throw new Error("Research fixture project is missing");
    await app.workspace.getLeaf(false).openFile(project);
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = harness.page.locator(".cc-chat-root");
  await expect(chat).toBeVisible();
  const workspace = chat.locator(".cc-context-workspace");
  await expect(workspace).toContainText("Continue Continuity research");
  await expect(workspace.getByRole("button", { name: "Open Research Desk" })).toBeVisible();
  await workspace.getByRole("button", { name: "Ask Companion" }).click();
  await expect(chat.locator(".cc-attach-pill").filter({ hasText: "Project" })).toHaveCount(1);
  await expect(chat.locator("textarea")).toHaveValue(/Help me continue Continuity research/);
  await harness.page.locator(".workspace-split.mod-right-split").evaluate((element) => { (element as HTMLElement).style.width = "390px"; });
  await expect.poll(async () => await chat.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await chat.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/07-companion-context.png" });
  expect(consoleFailures.filter((failure) => /EPIPE|unhandled/i.test(failure))).toEqual([]);
});
