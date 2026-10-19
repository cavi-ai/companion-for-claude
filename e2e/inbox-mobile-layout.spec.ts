import { expect, test } from "./fixtures";

const LONG = "p-e-wheretic reverse engineering a very long clipped article title";

test("the Inbox enrichment rows keep their own fills and fit a phone-width sidebar", async ({ rig }) => {
  const { page } = await rig.reset({
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow" },
    extraFiles: {
      [`Clippings/${LONG}.md`]: "---\nsource: https://example.com/a\n---\nClipped body.\n",
      "Clippings/Typed clip.md": "---\ntitle: Typed clip\ntype: article\nsource_enriched: true\n---\n# Typed clip\n\nBody.\n",
    },
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(async () => {
    document.body.classList.add("is-mobile", "is-phone");
    const rightSplit = document.querySelector<HTMLElement>(".workspace-split.mod-right-split");
    if (!rightSplit) throw new Error("Right sidebar is missing");
    for (const [name, value] of [["display", "flex"], ["position", "fixed"], ["inset", "0"], ["width", "100vw"], ["min-width", "0"], ["z-index", "100"]]) {
      rightSplit.style.setProperty(name!, value!, "important");
    }
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } })
      .app.commands.executeCommandById("claude-companion:open-source-inbox");
  });
  const inbox = page.locator(".cc-inbox-view:visible").first();
  const row = inbox.locator(".cc-inbox-list .cc-inbox-row", { hasText: "p-e-wheretic" });
  await expect(row.locator(".cc-inbox-enrichment-status")).toHaveText("Ready");

  const styles = await inbox.evaluate((root) => {
    const style = (selector: string) => getComputedStyle(root.querySelector(selector)!);
    return {
      open: { background: style(".cc-inbox-open").backgroundColor, shadow: style(".cc-inbox-open").boxShadow },
      enrich: style("button.cc-inbox-enrich").backgroundColor,
      enrichAll: style(".cc-inbox-enrich-all").backgroundColor,
      clay: style(".cc-inbox-type").color,
      organize: style(".cc-inbox-organize").backgroundColor,
    };
  });
  expect(styles.open).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none" });
  expect(styles.enrich).toBe("rgba(0, 0, 0, 0)");
  expect(styles.organize).toBe("rgba(0, 0, 0, 0)");
  expect(styles.enrichAll).toBe(styles.clay);

  const [count, backend, enrichAll] = await Promise.all([".cc-inbox-count", ".cc-inbox-backend", ".cc-inbox-enrich-all"].map((s) => inbox.locator(s).boundingBox()));
  expect(count!.height).toBeLessThan(30);
  expect(backend!.y).toBeGreaterThanOrEqual(Math.max(count!.y + count!.height, enrichAll!.y + enrichAll!.height) - 1);

  const rowBox = (await row.boundingBox())!;
  for (const child of await row.locator(":scope > *").all()) {
    const box = (await child.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  }
  await expect.poll(async () => await row.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
});

test("invalid clip properties stay readable and can be corrected before retry", async ({ rig }) => {
  const path = `Clippings/${LONG}.md`;
  const malformed = "---\n\n## Introduction\n\nArticle text\nwith: invalid: YAML\n---\n\nBody.  \n";
  const { page } = await rig.reset({
    settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow" },
    extraFiles: { [path]: malformed },
    providerReply: [{ match: "/./", replies: [JSON.stringify({ title: "Corrected clip", site: "Example", summary: "A concise summary." })] }],
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-source-inbox");
  });
  const inbox = page.locator(".cc-inbox-view:visible").first();
  const row = inbox.locator(".cc-inbox-row", { hasText: LONG });
  await row.getByRole("button", { name: `Enrich ${LONG}`, exact: true }).click();
  await expect(row.locator(".cc-inbox-enrichment-error")).toContainText("Open the note and fix its opening YAML properties block, then retry.");
  expect(await rig.providerRequests()).toBe(0);

  const sidebarStyle = await page.locator(".workspace-split.mod-right-split").getAttribute("style");
  const viewport = page.viewportSize();
  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".workspace-split.mod-right-split")!;
      for (const [name, value] of Object.entries({ display: "flex", position: "fixed", inset: "0", width: "100vw", "min-width": "0", "z-index": "100" })) {
        sidebar.style.setProperty(name, value, "important");
      }
    });
    const bounds = await row.evaluate((element) => {
      const name = element.querySelector(".cc-inbox-open")!.getBoundingClientRect();
      const error = element.querySelector(".cc-inbox-enrichment-error")!.getBoundingClientRect();
      return { overflow: element.scrollWidth - element.clientWidth, nameWidth: name.width, nameBottom: name.bottom, errorTop: error.top };
    });
    expect(bounds.overflow).toBeLessThanOrEqual(1);
    expect(bounds.nameWidth).toBeGreaterThan(100);
    expect(bounds.errorTop).toBeGreaterThanOrEqual(bounds.nameBottom);
  }

  await page.locator(".workspace-split.mod-right-split").evaluate((element, style) => { element.setAttribute("style", style ?? ""); }, sidebarStyle);
  if (viewport) await page.setViewportSize(viewport);
  await row.locator(".cc-inbox-open").click();
  const before = await page.evaluate(async (path) => {
    const app = (window as unknown as { app: { workspace: { getActiveFile(): { path: string } | null }; vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string>; modify(file: unknown, content: string): Promise<void> } } }).app;
    if (app.workspace.getActiveFile()?.path !== path) throw new Error("The failed note did not open");
    const file = app.vault.getAbstractFileByPath(path);
    return app.vault.read(file);
  }, path);
  expect(before).toBe(malformed);
  const editor = page.locator(".markdown-source-view:visible .cm-content");
  await editor.click();
  await editor.press("Meta+A");
  await page.keyboard.insertText("---\nsource: https://example.com/article\n---\n\nBody.  \n");
  await row.getByRole("button", { name: `Enrich ${LONG}`, exact: true }).click();
  await expect(inbox.locator(".cc-inbox-typed")).toContainText(LONG);
  expect(await rig.providerRequests()).toBe(1);
});
