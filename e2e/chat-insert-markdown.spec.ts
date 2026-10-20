import { expect, test } from "./fixtures";

type VaultWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  vault: { getAbstractFileByPath(path: string): unknown; cachedRead(file: unknown): Promise<string> };
  workspace: {
    getLeaf(value: boolean): { openFile(file: unknown, options?: { state: { mode: string } }): Promise<void> };
    getLeavesOfType(type: string): { view: { file?: { path: string }; editor: { setCursor(position: { line: number; ch: number }): void; getValue(): string } } }[];
  };
} };

test("inserting a structured reply preserves the existing paragraph and its new heading", async ({ rig }, testInfo) => {
  const original = "# Review\n\nKeep the existing guidance.";
  const answer = "## Findings\n\n- Started in March.\n- Needs review.";
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, autoTagOnSave: false },
    extraFiles: { "Notes/Review.md": original },
    providerReply: [{ match: ".", replies: [answer] }],
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Notes/Review.md"));
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("Give me a short findings section to add to this note.");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  const reply = chat.locator(".cc-assistant").last();
  await expect(reply.getByRole("button", { name: "Insert", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const view = (window as unknown as VaultWindow).app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === "Notes/Review.md")!.view;
    view.editor.setCursor({ line: 2, ch: "Keep the existing guidance.".length });
  });
  await reply.getByRole("button", { name: "Insert", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("inserted-findings-section.png") });
  const text = await page.evaluate(() => {
    const view = (window as unknown as VaultWindow).app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === "Notes/Review.md")!.view;
    return view.editor.getValue();
  });
  expect(text).toBe(`${original}\n\n${answer}`);
  await expect(page.locator(".markdown-source-view .cm-content")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await page.evaluate(() => {
    const view = (window as unknown as VaultWindow).app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === "Notes/Review.md")!.view;
    return view.editor.getValue();
  })).toBe(original);
  await page.screenshot({ path: testInfo.outputPath("immediate-undo-restores-note.png") });
  expect(errors).toEqual([]);
});

test("inserting into a note in Reading view reveals the editor and supports immediate Undo", async ({ rig }, testInfo) => {
  const original = "# Review\n\nKeep the existing guidance.";
  const answer = "## Findings\n\n- Started in March.";
  const { page } = await rig.reset({
    settingsOverride: { agentModeEnabled: false, autoTagOnSave: false },
    extraFiles: { "Notes/Reading.md": original },
    providerReply: [{ match: ".", replies: [answer] }],
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => {
    const app = (window as unknown as VaultWindow).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Notes/Reading.md"), { state: { mode: "preview" } });
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  await expect(page.locator(".markdown-reading-view")).toBeVisible();
  const chat = page.locator(".cc-chat-root");
  await chat.locator(".cc-input").fill("Give me a findings section for this note.");
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  const reply = chat.locator(".cc-assistant").last();
  await expect(reply.getByRole("button", { name: "Insert", exact: true })).toBeVisible();
  await reply.getByRole("button", { name: "Insert", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("insert-from-reading-view.png") });
  await expect(page.locator(".markdown-source-view")).toBeVisible();
  await expect(page.locator(".markdown-source-view .cm-content")).toBeFocused();
  const current = () => page.evaluate(() => {
    const view = (window as unknown as VaultWindow).app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === "Notes/Reading.md")!.view;
    return view.editor.getValue();
  });
  expect(await current()).toContain(answer);
  expect(await current()).toContain(original);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await current()).toBe(original);
  await page.screenshot({ path: testInfo.outputPath("reading-view-insertion-undone.png") });
  expect(errors).toEqual([]);
});
