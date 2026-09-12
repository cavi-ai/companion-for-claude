import { expect, test } from "./fixtures";
import { launchObsidianHarness } from "./obsidianHarness";

test("ordinary scenarios reuse one Obsidian process with isolated vault state", async () => {
  const first = await launchObsidianHarness({
    extraFiles: { "Transient.md": "# Must not leak\n" },
    settingsOverride: { customModel: "temporary-e2e-model" },
  });
  const processId = first.processId;
  try {
    await expect.poll(() => first.page.evaluate(() => {
      const app = (window as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown } } }).app;
      return Boolean(app.vault.getAbstractFileByPath("Transient.md"));
    })).toBe(true);
  } finally {
    await first.close();
  }

  const second = await launchObsidianHarness();
  try {
    expect(second.processId).toBe(processId);
    await expect.poll(() => second.page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          plugins: { plugins: Record<string, { settings: { customModel: string } }> };
          vault: { getAbstractFileByPath(path: string): unknown };
        };
      }).app;
      return {
        customModel: app.plugins.plugins["claude-companion"].settings.customModel,
        transientExists: Boolean(app.vault.getAbstractFileByPath("Transient.md")),
      };
    })).toEqual({ customModel: "", transientExists: false });
  } finally {
    await second.close();
  }
});
