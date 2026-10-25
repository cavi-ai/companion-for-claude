import { expect, openSettingsSection, test } from "./fixtures";
import type ClaudeCompanionPlugin from "../src/main";
import type { SemanticIndexer } from "../src/semantic/indexer";

test("rebuild settings show batch progress, elapsed time, and an estimate", async ({ rig }) => {
  await rig.reset({ embedStub: true });
  const settings = await openSettingsSection(rig, "Semantic search");
  await rig.page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { create(path: string, body: string): Promise<unknown> }; plugins: { plugins: Record<string, ClaudeCompanionPlugin> } } }).app;
    const files = [];
    for (let i = 0; i < 5; i++) {
      const path = `Progress-${i}.md`;
      await app.vault.create(path, "word ".repeat(700));
      files.push({ path, mtime: Date.now() });
    }
    const index = app.plugins.plugins["claude-companion"]!.semantic().indexer()!;
    const deps = (index as unknown as { deps: ConstructorParameters<typeof SemanticIndexer>[0] }).deps;
    deps.listMarkdown = () => files;
    deps.embedBatchSize = 1;
    const embed = deps.embed;
    deps.embed = async (texts) => {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      return embed(texts);
    };
  });
  const row = settings.locator(".setting-item:visible", { hasText: "Rebuild index" }).first();
  await row.getByRole("button", { name: "Rebuild", exact: true }).click();
  const status = row.locator(".cc-semantic-index-status");
  await expect(status).toContainText("chunks embedded");
  await expect(status).toContainText("Elapsed:");
  await expect(status).toContainText("Estimated remaining: Estimating…");
  await expect(status).toContainText("Estimated remaining: ~", { timeout: 15_000 });
  await expect(row.locator("button")).toBeDisabled();
  await settings.setViewportSize({ width: 390, height: 844 });
  await row.screenshot({ path: test.info().outputPath("progress-settings.png") });
  await expect(status).toContainText("Index ready", { timeout: 15_000 });
  await expect(row.getByRole("button", { name: "Rebuild", exact: true })).toBeEnabled();
});
