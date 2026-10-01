import { expect, test } from "./fixtures";
import type { Rig } from "./fixtures";

test.describe.configure({ mode: "serial" });
let harness: Rig;
let consoleFailures: string[] = [];

function paddedPdf(size: number): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const fixture = Buffer.alloc(size, 0x20);
  Buffer.from(body).copy(fixture);
  return fixture;
}

test.beforeAll(async ({ rig }) => {
  harness = await rig.reset();
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

test("03b Re-check clears: the top action opens the changed passage and Keep resolves it", async () => {
  await harness.page.evaluate(() => { (window as unknown as { app: { plugins: { plugins: Record<string, { researchDeskPreferences: unknown }> } } }).app.plugins.plugins["claude-companion"]!.researchDeskPreferences = {}; });
  const desk = harness.page.locator(".cc-research-desk");
  await desk.getByLabel("Active research project").selectOption("Research/Beta/Project.md");
  await desk.getByLabel("Active research project").selectOption("Research/Alpha/Project.md");
  await expect(desk.locator(".cc-desk-next h3")).toHaveText("Re-check Stale result");
  await desk.getByRole("button", { name: "Start this task", exact: true }).click();
  const modal = harness.page.locator(".modal-container").last();
  await expect(modal.getByRole("heading", { name: "Check Stale result" })).toBeVisible();
  await expect(modal).toContainText("The source changed since this was checked");
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(desk.locator(".cc-desk-next h3")).not.toHaveText("Re-check Stale result");
});

test("04 handoff: each quick action does its step", async () => {
  const openDesk = async () => {
    await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk"); });
    await expect(harness.page.locator(".cc-research-desk")).toBeVisible();
  };
  const quick = (name: string) => harness.page.locator(".cc-research-desk").getByRole("button", { name, exact: true });
  for (const [button, heading] of [["Add source", "Add research source"], ["Extract evidence", "Pull passages from a source"], ["Develop claim", "New claim"]] as const) {
    await quick(button).click();
    await expect(harness.page.locator(".modal-container").last().getByRole("heading", { name: heading })).toBeVisible();
    await harness.page.keyboard.press("Escape");
  }
  for (const [button, tab] of [["Continue draft", "Draft"], ["Run audit", "Audit"]] as const) {
    await quick(button).click();
    const workbench = harness.page.locator(".cc-research-workbench");
    await expect(workbench).toBeVisible();
    await expect(workbench.locator(".cc-research-tab-select")).toHaveValue(tab);
    await openDesk();
  }
});

test("05 advanced workbench: grouped navigation exposes every research panel without implicit network work", async () => {
  await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-workbench"); });
  const workbench = harness.page.locator(".cc-research-workbench");
  await expect(workbench.locator(".cc-research-tab-group")).toHaveCount(4);
  await expect(workbench.locator(".cc-research-header-top .cc-workspace-navigation")).toBeVisible();
  const before = await harness.providerRequests();
  for (const tab of ["Overview", "Sources", "Evidence", "Claims", "Outline", "Draft", "Audit", "Intelligence", "Discover"]) {
    await workbench.locator(".cc-research-tab-select").selectOption(tab);
    await expect(workbench.getByRole("tabpanel")).toBeVisible();
    await expect(workbench.locator(".cc-research-panel-intro")).toBeVisible();
  }
  await expect(workbench.getByRole("heading", { name: "Scholarly discovery is off" })).toBeVisible();
  await expect(workbench.getByLabel("Discovery query")).toHaveCount(0);
  await expect(workbench.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
  await expect.poll(async () => await workbench.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await harness.providerRequests()).toBe(before);
  await harness.page.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/05-workbench.png" });

  for (const [tab, title, artifact] of [["Overview", "Project overview", "05a-overview"], ["Sources", "Source library", "05b-sources"], ["Evidence", "Evidence review", "05c-evidence"], ["Intelligence", "Insights", "05d-intelligence"]] as const) {
    await workbench.locator(".cc-research-tab-select").selectOption(tab);
    await expect(workbench.locator(".cc-research-panel-title")).toHaveText(title);
    await expect(workbench.getByRole("heading", { name: "Continuity research" })).toBeVisible();
    await workbench.evaluate((element) => { element.scrollTop = 0; });
    await workbench.screenshot({ path: `/private/tmp/claude-companion-research-e2e-results/${artifact}.png` });
  }
});

test("06 PDF source import: a 10 MiB document stays in the live renderer", async () => {
  const workbench = harness.page.locator(".cc-research-workbench");
  await workbench.locator(".cc-research-tab-select").selectOption("Sources");
  await harness.page.bringToFront();
  await workbench.getByRole("button", { name: "Add source", exact: true }).click();
  const capture = harness.page.locator(".modal-container").last();
  await expect(capture.getByRole("heading", { name: "Add research source" })).toBeVisible();
  await capture.locator("input.cc-source-file-input").setInputFiles({
    name: "Renderer stress.pdf",
    mimeType: "application/pdf",
    buffer: paddedPdf(10 * 1024 * 1024),
  });
  await expect(capture.getByRole("status")).toContainText("Imported “Renderer stress”", { timeout: 30_000 });
  await expect(workbench).toBeVisible();
  await expect(workbench.getByText("Renderer stress", { exact: true })).toBeVisible();
  expect(consoleFailures.filter((failure) => /out of memory|renderer|unhandled/i.test(failure))).toEqual([]);
  await harness.page.keyboard.press("Escape");
  await expect(capture).toBeHidden();
});

test("07 native continuity: evidence becomes a claim and an outline without leaving the workbench", async () => {
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
  await expect(review.getByRole("heading", { name: "Check Challenge" })).toBeVisible();
  await expect(review.locator(".cc-research-evidence-excerpt")).toContainText("Continuity varies by workflow");
  await verifyModalWidths(review, "Keep", "06a-review-evidence-mobile");
  await review.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/06a-review-evidence.png" });
  await review.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(review).toBeHidden();

  await workbench.locator(".cc-research-tab-select").selectOption("Claims");
  await workbench.getByRole("button", { name: "Create claim", exact: true }).click();
  const claim = harness.page.locator(".modal-container").last();
  await claim.getByLabel("Short title").fill("Workflow continuity claim");
  await claim.getByLabel("Claim", { exact: true }).fill("Reviewed evidence preserves continuity across the workflow.");
  await claim.getByLabel("Challenge supports").check();
  await verifyModalWidths(claim, "Create claim", "06b-create-claim-mobile");
  await claim.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/06b-create-claim.png" });
  await claim.getByRole("button", { name: "Create claim", exact: true }).click();
  await expect(claim).toBeHidden();
  await expect(workbench.getByText("Workflow continuity claim", { exact: true })).toBeVisible();

  await workbench.locator(".cc-research-tab-select").selectOption("Outline");
  await workbench.getByRole("button", { name: "Build outline", exact: true }).click();
  const outline = harness.page.locator(".modal-container").last();
  await expect(outline.getByRole("heading", { name: "Build the outline" })).toBeVisible();
  await expect(outline.getByLabel("Include Continuity claim")).toBeChecked();
  await verifyModalWidths(outline, "Build outline", "06c-build-outline-mobile");
  await outline.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/06c-build-outline.png" });
  await outline.getByRole("button", { name: "Build outline", exact: true }).click();
  await expect(outline).toBeHidden();
  await expect(harness.page.locator(".workspace-leaf-content[data-type='markdown']").last()).toContainText("Outline");
  expect(consoleFailures.filter((failure) => /EPIPE|unhandled/i.test(failure))).toEqual([]);
});

test("08 accessibility and responsive states: controls remain named and reachable", async () => {
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

test("09 Companion continuity: active research becomes context, not a new home", async () => {
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
  const contextTrigger = chat.locator(".cc-context-trigger");
  await expect(contextTrigger).toHaveAttribute("aria-label", /Manage context, \d+ items active/);
  await contextTrigger.click();
  const contextManager = chat.getByRole("dialog", { name: "Message context" });
  await expect(contextManager.getByLabel("This note")).toBeChecked();
  await expect(contextManager.getByText("Research/Alpha/Project.md", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Close message context" }).click();
  await expect(chat.locator("textarea")).toHaveValue(/Help me continue Continuity research/);
  await harness.page.locator(".workspace-split.mod-right-split").evaluate((element) => { (element as HTMLElement).style.width = "390px"; });
  await expect.poll(async () => await chat.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await chat.screenshot({ path: "/private/tmp/claude-companion-research-e2e-results/07-companion-context.png" });
  expect(consoleFailures.filter((failure) => /EPIPE|unhandled/i.test(failure))).toEqual([]);
});

test("10 pull passages: Claude's exact passage is added with its section filled in", async () => {
  const reply = JSON.stringify({ passages: [{ title: "Captured", excerpt: "Captured study.", interpretation: "The study was captured." }] });
  harness = await harness.reset({ providerReply: [{ match: "exact passages", flags: "i", replies: [reply] }] });
  await harness.page.evaluate(async () => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-research-desk"); });
  const desk = harness.page.locator(".cc-research-desk");
  await desk.getByLabel("Active research project").selectOption("Research/Alpha/Project.md");
  await desk.getByRole("button", { name: "Extract evidence", exact: true }).click();
  const modal = harness.page.locator(".modal-container").last();
  await expect(modal.getByRole("heading", { name: "Pull passages from a source" })).toBeVisible();
  await expect(modal.locator("blockquote")).toHaveText("Captured study.");
  await expect(modal.getByLabel("Where it is: type").first()).toHaveValue("section");
  await expect(modal.getByLabel("Where it is: value").first()).toHaveValue("Source");
  await modal.getByRole("button", { name: "Add 1 passage", exact: true }).click();
  await expect(modal).toBeHidden();
  const names = await harness.page.evaluate(() => (window as unknown as { app: { vault: { getMarkdownFiles(): Array<{ path: string }> } } }).app.vault.getMarkdownFiles().map(({ path }) => path).filter((path) => path.startsWith("Research/Alpha/Evidence/")));
  expect(names.some((path) => /Captured/.test(path))).toBe(true);
});
