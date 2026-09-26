import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures";

const NOTES = ["Library/ai/first clip.md", "Library/ai/second clip.md", "Concepts/idea.md"];

test("notes that arrived while the plugin was off are indexed at startup without a manual rebuild", async ({ rig }) => {
  const harness = await rig.reset({ embedStub: true });
  const { page } = harness;
  const indexPath = join(harness.paths.vault, ".obsidian", "plugins", "claude-companion", "semantic-index.json");
  const indexed = async (): Promise<string[]> => {
    try {
      return Object.keys((JSON.parse(await readFile(indexPath, "utf8")) as { notes: Record<string, unknown> }).notes);
    } catch {
      return [];
    }
  };
  const setPlugin = (on: boolean) => page.evaluate(async (enable) => {
    const plugins = (window as unknown as { app: { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } } }).app.plugins;
    await (enable ? plugins.enablePlugin("claude-companion") : plugins.disablePlugin("claude-companion"));
  }, on);

  await setPlugin(false);
  for (const [i, path] of NOTES.entries()) {
    const dest = join(harness.paths.vault, path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, `# Note ${i}\n\nBody text for note ${i}.`);
  }
  await expect.poll(() => page.evaluate((paths) => paths.every((p) =>
    (window as unknown as { app: { vault: { getAbstractFileByPath(p: string): unknown } } }).app.vault.getAbstractFileByPath(p) !== null), NOTES), { timeout: 10_000 }).toBe(true);
  expect(await indexed()).not.toEqual(expect.arrayContaining([NOTES[0]]));

  await setPlugin(true);
  await expect.poll(indexed, { timeout: 20_000 }).toEqual(expect.arrayContaining(NOTES));
});
