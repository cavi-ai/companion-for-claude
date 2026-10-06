import { expect, test } from "./fixtures";

const NOTE = [
  "# Status",
  "",
  "```claude-html",
  "<!doctype html><html><body><h1>Board</h1></body></html>",
  "```",
  "",
].join("\n");

type AppSeam = {
  app: {
    metadataCache: { getFirstLinkpathDest(link: string, source: string): unknown };
    workspace: { getLeaf(kind: string): { openFile(file: unknown, state?: unknown): Promise<void> } };
  };
};

test("an artifact rendered in a note draws its toolbar from the Companion palette", async ({ rig }) => {
  const harness = await rig.reset({ extraFiles: { "Status.md": NOTE } });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const { app } = window as unknown as AppSeam;
      const file = app.metadataCache.getFirstLinkpathDest("Status", "");
      if (!file) throw new Error("Status.md not indexed");
      await app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
    });
    const bar = page.locator(".markdown-preview-view .cc-artifact-bar").first();
    await expect(bar).toBeVisible({ timeout: 15_000 });

    const styles = await bar.evaluate((el) => {
      const pick = (node: Element | null) => {
        if (!node) throw new Error("toolbar element missing");
        const s = getComputedStyle(node);
        return { background: s.backgroundColor, color: s.color, font: s.fontFamily };
      };
      return {
        bar: pick(el),
        label: pick(el.querySelector(".cc-artifact-label")),
        open: pick(el.querySelector(".cc-artifact-open")),
      };
    });
    expect(styles.bar.background).toBe("rgb(240, 238, 230)");
    expect(styles.label.color).toBe("rgb(61, 61, 58)");
    expect(styles.label.font).toContain("Menlo");
    expect(styles.open.background).toBe("rgb(255, 255, 255)");
    expect(styles.open.color).toBe("rgb(61, 61, 58)");
  } finally {
    await harness.close();
  }
});
