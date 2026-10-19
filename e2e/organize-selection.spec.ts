import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): void };
  vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> };
} };

test("clipping move labels support text clicks, keyboard selection and cancel", async ({ rig }, testInfo) => {
  const notes = ["Seed growing", "Watering garden", "Loose notes"];
  const files = Object.fromEntries(notes.map((title) => [`Clippings/${title}.md`, `---\ntitle: ${title}\ntype: article\nsource_enriched: true\nsummary: Garden advice.\n---\n# ${title}\n\nOriginal advice.\n`]));
  const proposals = notes.map((title) => ({ path: `Clippings/${title}.md`, domain: title === "Loose notes" ? "misc" : "gardening" }));
  const { page } = await rig.reset({ extraFiles: files, settingsOverride: { sourceCaptureEnabled: true, sourceEnrichOnCreate: false, sourceCaptureConsent: "allow" }, providerReply: [{ match: "/./", replies: [JSON.stringify(proposals)] }] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = () => page.evaluate(() => (window as unknown as AppWindow).app.commands.executeCommandById("claude-companion:organize-clippings"));
  const modal = page.locator(".cc-organize-review");
  const watering = modal.getByRole("checkbox", { name: "Clippings/Watering garden.md → Library/gardening/Watering garden.md", exact: true });
  const loose = modal.getByRole("checkbox", { name: "Clippings/Loose notes.md → Library/misc/Loose notes.md", exact: true });
  const read = (path: string) => page.evaluate(async (value) => { const { vault } = (window as unknown as AppWindow).app; const file = vault.getAbstractFileByPath(value); return file ? vault.read(file) : null; }, path);
  await open();
  await expect(modal.getByRole("checkbox")).toHaveCount(3);
  await expect(watering).toBeChecked();
  await expect(loose).not.toBeChecked();
  await modal.locator(".cc-organize-from").filter({ hasText: "Clippings/Watering garden.md" }).click();
  await expect(watering).not.toBeChecked();
  await loose.focus();
  await loose.press("Space");
  await expect(loose).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("named-clipping-selections.png"), animations: "disabled" });
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const [path, content] of Object.entries(files)) expect(await read(path)).toBe(content);
  for (const proposal of proposals) expect(await read(`Library/${proposal.domain}/${proposal.path.split("/").pop()}`)).toBeNull();
  await open();
  await expect(watering).toBeChecked();
  await expect(loose).not.toBeChecked();
  await modal.locator(".cc-organize-to").filter({ hasText: "Library/gardening/Watering garden.md" }).click();
  await loose.focus();
  await loose.press("Space");
  await modal.getByRole("button", { name: "Move selected", exact: true }).click();
  await expect(page.locator(".notice").filter({ hasText: "Organized 2 clippings" })).toBeVisible();
  expect(await read("Library/gardening/Seed growing.md")).toBe(files["Clippings/Seed growing.md"]);
  expect(await read("Library/misc/Loose notes.md")).toBe(files["Clippings/Loose notes.md"]);
  expect(await read("Clippings/Watering garden.md")).toBe(files["Clippings/Watering garden.md"]);
  expect(await read("Clippings/Seed growing.md")).toBeNull();
  expect(await read("Clippings/Loose notes.md")).toBeNull();
  expect(await read("Library/gardening/Watering garden.md")).toBeNull();
  expect(errors).toEqual([]);
});
