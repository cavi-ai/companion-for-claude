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

const run = (command: string) => harness.page.evaluate(async (id) => { await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById(id); }, command);
const openDesk = async () => { await run("claude-companion:open-research-desk"); await expect(harness.page.locator(".cc-research-desk")).toBeVisible(); };
const deskLocator = () => harness.page.locator(".cc-research-desk");
const readVaultFile = (path: string) => harness.page.evaluate((target) => (window as unknown as { app: { vault: { adapter: { read(path: string): Promise<string> } } } }).app.vault.adapter.read(target), path);

test("01 launch: one Research view, no tabs, no console failure", async () => {
  await openDesk();
  await expect(harness.page.getByRole("heading", { name: "Continuity research" })).toBeVisible();
  await expect(harness.page.locator(".cc-research-tabs")).toHaveCount(0);
  expect(consoleFailures.filter((failure) => /EPIPE|claude-companion|unhandled/i.test(failure))).toEqual([]);
});

test("02 steps: the top step re-checks the changed passage and Keep resolves it", async () => {
  const desk = deskLocator();
  const steps = desk.locator(".cc-desk-step");
  expect(await steps.count()).toBeGreaterThanOrEqual(1);
  expect(await steps.count()).toBeLessThanOrEqual(3);
  await expect(steps.first()).toHaveText(/^Re-check "Stale result"/);
  await steps.first().click();
  const modal = harness.page.locator(".modal-container").last();
  await expect(modal.getByRole("heading", { name: "Check Stale result" })).toBeVisible();
  await modal.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(desk.locator(".cc-desk-steps")).not.toContainText('Re-check "Stale result"');
});

test("03 ask: a typed instruction reaches the chat with the project attached", async () => {
  const before = await harness.providerRequests();
  const desk = deskLocator();
  await desk.getByLabel("Instruction for Claude").fill("Summarize the argument");
  await desk.getByRole("button", { name: "Send", exact: true }).click();
  const chat = harness.page.locator(".cc-chat-root");
  await expect(chat).toBeVisible();
  await expect(chat.locator(".cc-msg.cc-user").last()).toContainText("Summarize the argument");
  await chat.locator(".cc-context-trigger").click();
  const contextManager = chat.getByRole("dialog", { name: "Message context" });
  await expect(contextManager.getByText("Research/Alpha/Project.md", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Close message context" }).click();
  await expect.poll(async () => await harness.providerRequests()).toBeGreaterThanOrEqual(before + 1);
});

test("04 cards: a claim card shows its status and expands to its passages", async () => {
  await openDesk();
  const card = deskLocator().locator(".cc-desk-card", { hasText: "Continuity claim" });
  await expect(card.locator(".cc-desk-chip")).toBeVisible();
  await card.locator(".cc-desk-card-head").click();
  await expect(deskLocator().locator(".cc-desk-card", { hasText: "Continuity claim" })).toContainText("Supports: Stale result");
  await expect(deskLocator().locator(".cc-desk-card", { hasText: "Continuity claim" })).toContainText("Challenges: Challenge");
});

test("05 no implicit work: switching projects sends no request and the desk fits 390 px", async () => {
  await openDesk();
  await expect.poll(async () => await harness.providerRequests()).toBeGreaterThanOrEqual(1);
  const before = await harness.providerRequests();
  const desk = deskLocator();
  await desk.getByLabel("Active research project").selectOption("Research/Beta/Project.md");
  await expect(desk.getByRole("heading", { name: "Empty project" })).toBeVisible();
  await expect(desk.locator(".cc-desk-step")).toContainText("Add a first source");
  await harness.page.locator(".workspace-split.mod-right-split").evaluate((element) => { (element as HTMLElement).style.width = "390px"; });
  await expect.poll(async () => await desk.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await desk.getByLabel("Active research project").selectOption("Research/Alpha/Project.md");
  await expect(desk.getByRole("heading", { name: "Continuity research" })).toBeVisible();
  await expect.poll(async () => await desk.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await harness.providerRequests()).toBe(before);
});

test("06 PDF source import: a 10 MiB document stays in the live renderer", async () => {
  const desk = deskLocator();
  await harness.page.bringToFront();
  await desk.locator(".cc-desk-sources").getByRole("button", { name: "Link or file", exact: true }).click();
  const capture = harness.page.locator(".modal-container").last();
  await expect(capture.getByRole("heading", { name: "Add research source" })).toBeVisible();
  await capture.locator("input.cc-source-file-input").setInputFiles({
    name: "Renderer stress.pdf",
    mimeType: "application/pdf",
    buffer: paddedPdf(10 * 1024 * 1024),
  });
  await expect(capture.getByRole("status")).toContainText("Imported “Renderer stress”", { timeout: 30_000 });
  await harness.page.keyboard.press("Escape");
  await expect(capture).toBeHidden();
  await expect(async () => {
    const group = deskLocator().locator(".cc-desk-group", { hasText: "Unread sources" });
    if (!(await group.evaluate((element) => (element as HTMLDetailsElement).open))) await group.locator("summary").click();
    await expect(group.getByText("Renderer stress", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  expect(consoleFailures.filter((failure) => /out of memory|renderer|unhandled/i.test(failure))).toEqual([]);
});

test("07 clean up format: a v1 outline converts and renders References", async () => {
  const desk = deskLocator();
  await desk.getByLabel("Active research project").selectOption("Research/Gamma/Project.md");
  await expect(desk.getByRole("heading", { name: "Gamma research" })).toBeVisible();
  await desk.getByRole("button", { name: "Clean up format", exact: true }).click();
  await expect(desk.getByRole("button", { name: "Clean up format", exact: true })).toHaveCount(0);
  const converted = await readVaultFile("Research/Gamma/Documents/Outline.md");
  expect(converted).not.toContain("cavi:draft-section");
  expect(converted).toContain("claude-provenance");
  await harness.page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown }; workspace: { getLeaf(value: boolean): { openFile(file: unknown, state?: unknown): Promise<void> } } } }).app;
    const file = app.vault.getAbstractFileByPath("Research/Gamma/Documents/Outline.md");
    if (!file) throw new Error("Gamma outline is missing");
    await app.workspace.getLeaf("tab" as unknown as boolean).openFile(file, { state: { mode: "preview" } });
  });
  const references = harness.page.locator(".markdown-reading-view .cc-provenance");
  await expect(references).toBeVisible();
  await expect(references).toContainText("References");
});

test("08 draft section: a previewed section is accepted into clean prose", async () => {
  const sentence = "Gamma preserves continuity [@source-gamma-study].";
  const reply = JSON.stringify({
    markdown: sentence,
    support: [{ passage: sentence, claimPath: "Research/Gamma/Claims/Gamma claim.md", evidencePaths: ["Research/Gamma/Evidence/Gamma result.md"], citationKeys: ["source-gamma-study"] }],
    gaps: [],
  });
  harness = await harness.reset({ providerReply: [{ match: "Draft one research-document section", replies: [reply] }] });
  await openDesk();
  const desk = deskLocator();
  await desk.getByLabel("Active research project").selectOption("Research/Gamma/Project.md");
  await expect(desk.getByRole("heading", { name: "Gamma research" })).toBeVisible();
  await desk.locator(".cc-desk-step", { hasText: 'Draft "Gamma claim"' }).click();
  await desk.getByRole("button", { name: "Accept section", exact: true }).click();
  await expect(desk.locator(".cc-desk-document-progress")).toContainText("1 of 1 section drafted");
  const accepted = await readVaultFile("Research/Gamma/Documents/Outline.md");
  expect(accepted).toContain(`## Gamma claim\n\n${sentence}`);
  expect(accepted).not.toContain("cavi:draft-section");
  const provider = /"provider":\s*"([^"]+)"/.exec(accepted)?.[1];
  expect(provider).toBeTruthy();
  expect(provider).not.toBe("companion");
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
  await openDesk();
  const desk = deskLocator();
  await desk.getByLabel("Active research project").selectOption("Research/Alpha/Project.md");
  await desk.locator(".cc-desk-sources").getByRole("button", { name: "Pull passages", exact: true }).click();
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
