import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type Pos = { line: number; ch: number };

const NOTE = "# Build plan\n\n- [ ] Create the parser\n- [ ] Wire the interface\n";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const openNote = async (page: Page, link: string): Promise<void> => {
  await page.evaluate(async (l) => {
    const app = (window as unknown as { app: { workspace: { openLinkText(link: string, source: string, newLeaf: boolean): Promise<void> } } }).app;
    await app.workspace.openLinkText(l, "", false);
  }, link);
};

const placeCursor = async (page: Page, at: Pos): Promise<void> => {
  await page.evaluate((pos) => {
    const app = (window as unknown as { app: { workspace: { activeEditor: { editor: { setCursor(p: Pos): void; focus(): void } } | null } } }).app;
    const editor = app.workspace.activeEditor?.editor;
    if (!editor) throw new Error("no active editor");
    editor.focus();
    editor.setCursor(pos);
  }, at);
};

const editorText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const app = (window as unknown as { app: { workspace: { activeEditor: { editor: { getValue(): string } } | null } } }).app;
    return app.workspace.activeEditor?.editor.getValue() ?? "";
  });

const instruct = async (page: Page, instruction: string): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:rewrite-selection");
  });
  const input = page.locator(".cc-inline-prompt-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "Write at cursor…");
  await input.fill(instruction);
  await input.press("Enter");
};

test("writing at the cursor shows a pending insertion that Mod-Enter accepts", async ({ rig }) => {
  const harness = await rig.reset({ providerReply: [{ match: "insert at the cursor", flags: "i", replies: ["- [ ] Ship it"] }] });
  const { page } = harness;
  try {
    await openNote(page, "Build plan");
    // Line 4 is the empty line after the trailing newline.
    await placeCursor(page, { line: 4, ch: 0 });
    await instruct(page, "add a final ship step");

    const added = page.locator(".cc-inline-add");
    await expect(added).toHaveText(["- [ ] Ship it"], { timeout: 15_000 });
    await expect(page.locator(".cc-inline-prompt")).toHaveCount(0);
    expect(await editorText(page)).toBe(NOTE);

    const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? "");
    expect(focused, "the editor has focus when the review opens").toContain("cm-content");
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(added).toHaveCount(0);
    expect(await editorText(page)).toBe(`${NOTE}- [ ] Ship it`);
    expect(await harness.providerRequests()).toBe(1);
  } finally {
    await harness.close();
  }
});

test("Esc while the request runs stops it and leaves the note unchanged", async ({ rig }) => {
  const harness = await rig.reset({
    providerReply: [{ match: "insert at the cursor", flags: "i", replies: ["- [ ] Too late"] }],
    providerDelayMs: 3_000,
  });
  const { page } = harness;
  try {
    await openNote(page, "Build plan");
    await placeCursor(page, { line: 4, ch: 0 });
    await instruct(page, "add a final ship step");

    await expect(page.locator(".cc-inline-prompt-status")).toHaveText("Working… Esc to stop");
    await page.locator(".cc-inline-prompt-input").press("Escape");
    await expect(page.locator(".cc-inline-prompt")).toHaveCount(0);

    await expect.poll(() => harness.providerServed(), { timeout: 10_000 }).toBe(1);
    await expect(page.locator(".cc-inline-add")).toHaveCount(0);
    expect(await editorText(page)).toBe(NOTE);
  } finally {
    await harness.close();
  }
});
