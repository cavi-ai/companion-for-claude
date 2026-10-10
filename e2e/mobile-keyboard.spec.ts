import { expect, test } from "./fixtures";

test("the mobile composer keeps its place while the keyboard animates", async ({ rig }) => {
  const { page } = await rig.reset();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    document.body.classList.add("is-mobile");
    // A main-pane leaf sits inside Obsidian's app container, which shrinks above the keyboard.
    const workspace = (window as unknown as { app: { workspace: { getLeaf(tab: boolean): { setViewState(state: { type: string; active: boolean }): Promise<void> } } } }).app.workspace;
    await workspace.getLeaf(true).setViewState({ type: "claude-companion-chat", active: true });
  });
  const composer = page.locator(".workspace-split.mod-root .cc-chat-root .cc-composer");
  await expect(composer).toBeVisible();
  const bottom = async (): Promise<number> => { const box = (await composer.boundingBox())!; return box.y + box.height; };

  const atRest = await bottom();
  // The keyboard is up and settled: Obsidian shrinks the app above it.
  await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-height", "300px"));
  const settled = await bottom();
  expect(settled).toBeLessThan(atRest - 200);
  // The keyboard animates: Obsidian keeps the app full height until it settles.
  await page.evaluate(() => document.body.classList.add("keyboard-animating"));
  expect(Math.abs((await bottom()) - settled)).toBeLessThanOrEqual(1);
});
