import { expect, test } from "./fixtures";

const SCHEMA_NOTE = [
  "---",
  "ontology: type",
  "type_name: task",
  "version: 1",
  "---",
  "",
  "```yaml",
  "properties:",
  "  - key: status",
  "    type: \"string\"",
  "    required: true",
  "```",
  "",
  "Edit the yaml block above to change the `task` schema. Prose here is documentation — the plugin ignores it.",
  "",
].join("\n");

test("system status shows companion and vault problems", async ({ rig }) => {
  const { page } = await rig.reset({
    extraFiles: {
      "Notes/Linked.md": "# Linked\n\nSee [[Missing note]].\n",
      "Ontology/task.md": SCHEMA_NOTE,
      "Notes/Task one.md": "---\ntype: task\n---\n# Task one\n",
    },
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, { ontology(): { load(): Promise<unknown> } | null }> }; commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.plugins.plugins["claude-companion"]!.ontology()?.load();
    await app.commands.executeCommandById("claude-companion:open-system");
  });
  const view = page.locator(".cc-system-view:visible").first();
  await expect(view.locator(".cc-system-group").first()).toHaveText("COMPANION");
  await expect(async () => {
    await view.locator(".cc-system-refresh").click();
    await expect(view.locator(".cc-system-links")).toContainText("Broken links", { timeout: 1000 });
    await expect(view.locator(".cc-system-ontology")).toContainText("Ontology", { timeout: 1000 });
  }).toPass();
});
