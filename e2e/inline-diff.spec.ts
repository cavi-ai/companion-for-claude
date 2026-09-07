import { expect, test, type Page } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

type Pos = { line: number; ch: number };

const openNote = async (page: Page, link: string): Promise<void> => {
  await page.evaluate(async (l) => {
    const app = (window as unknown as { app: { workspace: { openLinkText(link: string, source: string, newLeaf: boolean): Promise<void> } } }).app;
    await app.workspace.openLinkText(l, "", false);
  }, link);
};

const select = async (page: Page, from: Pos, to: Pos): Promise<void> => {
  await page.evaluate(([a, b]) => {
    const app = (window as unknown as { app: { workspace: { activeEditor: { editor: { setSelection(a: Pos, b: Pos): void; focus(): void } } | null } } }).app;
    const editor = app.workspace.activeEditor?.editor;
    if (!editor) throw new Error("no active editor");
    editor.focus();
    editor.setSelection(a, b);
  }, [from, to] as const);
};

const editorText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const app = (window as unknown as { app: { workspace: { activeEditor: { editor: { getValue(): string } } | null } } }).app;
    return app.workspace.activeEditor?.editor.getValue() ?? "";
  });

const rewrite = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:rewrite-selection");
  });
  const modal = page.locator(".modal-container").filter({ hasText: "characters selected" });
  await expect(modal).toBeVisible();
  await modal.locator(".cc-rewrite-preset").first().click();
  await modal.getByRole("button", { name: "Rewrite", exact: true }).click();
};

test("a rewrite reviews inline: accept applies, reject leaves the note alone", async () => {
  const harness = await launchObsidianHarness({ providerReply: (body) => (/rewrite/i.test(body) ? "Build the tokenizer" : null) });
  const { page } = harness;
  try {
    await openNote(page, "Build plan");
    // "- [ ] Create the parser" is line 2; the text starts at ch 6.
    await select(page, { line: 2, ch: 6 }, { line: 2, ch: 23 });
    await rewrite(page);

    // wordDiff("Create the parser", "Build the tokenizer") yields two add runs
    // around the shared " the ": "Build" and "tokenizer" each get their own widget.
    const added = page.locator(".cc-inline-add");
    await expect(added).toHaveText(["Build", "tokenizer"], { timeout: 15_000 });
    await expect(page.locator(".cc-inline-del")).toHaveCount(2);
    await page.locator(".cc-inline-btn.is-accept").first().click();
    await expect(added).toHaveCount(0);
    expect(await editorText(page)).toContain("- [ ] Build the tokenizer");
    expect(await editorText(page)).not.toContain("Create the parser");

    await select(page, { line: 3, ch: 6 }, { line: 3, ch: 24 });
    await rewrite(page);
    // wordDiff("Wire the interface", "Build the tokenizer") has the same shape.
    await expect(page.locator(".cc-inline-add")).toHaveText(["Build", "tokenizer"], { timeout: 15_000 });
    await page.locator(".cc-inline-btn.is-reject").first().click();
    await expect(page.locator(".cc-inline-add")).toHaveCount(0);
    expect(await editorText(page)).toContain("- [ ] Wire the interface");
    expect(harness.providerRequests()).toBe(2);
  } finally {
    await harness.close();
  }
});

test("the selection action appears over a settled selection and opens the rewrite prompt", async () => {
  const harness = await launchObsidianHarness();
  const { page } = harness;
  try {
    await openNote(page, "Build plan");
    await select(page, { line: 2, ch: 6 }, { line: 2, ch: 23 });
    const action = page.locator(".cc-selection-action button", { hasText: "Rewrite with Claude" });
    await expect(action).toBeVisible({ timeout: 5_000 });
    await action.dispatchEvent("mousedown");
    await expect(page.locator(".modal-container").filter({ hasText: "characters selected" })).toBeVisible();
  } finally {
    await harness.close();
  }
});
