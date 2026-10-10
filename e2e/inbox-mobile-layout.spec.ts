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
