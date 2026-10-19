import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Published = { key: string; gistId: string; url: string };
type AppWindow = {
  app: {
    workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void> };
    commands: { executeCommandById(id: string): Promise<void> };
    plugins: { plugins: Record<string, { publishing(): { publishedItems(): Published[] } }> };
  };
  clipboardProbe?: { reject: boolean; attempts: string[]; restore(): void };
};

test("clipboard failure keeps a published note available for copying after reload without republishing", async ({ rig }, testInfo) => {
  const { githubPort } = await rig.control.ports();
  const note = "# Publish retry\n\nA shareable result.\n";
  const { page } = await rig.reset({ extraFiles: { "Publish retry.md": note }, settingsOverride: { publishApiBase: `http://127.0.0.1:${githubPort}`, publishGithubToken: "e2e-gist-token" } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const run = (id: string) => page.evaluate((command) => (window as unknown as AppWindow).app.commands.executeCommandById(`claude-companion:${command}`), id);
  const items = () => page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.publishing().publishedItems());
  await page.evaluate(async () => {
    const w = window as unknown as AppWindow;
    await w.app.workspace.openLinkText("Publish retry", "", false);
    const clipboard = navigator.clipboard;
    const original = Object.getOwnPropertyDescriptor(clipboard, "writeText");
    const probe = w.clipboardProbe = {
      reject: true,
      attempts: [] as string[],
      restore: () => { if (original) Object.defineProperty(clipboard, "writeText", original); else Reflect.deleteProperty(clipboard, "writeText"); },
    };
    Object.defineProperty(clipboard, "writeText", { configurable: true, value: async (text: string) => {
      probe.attempts.push(text);
      if (probe.reject) throw new DOMException("Clipboard unavailable", "NotAllowedError");
    } });
  });
  try {
    await run("publish-note");
    await page.locator(".modal").getByRole("button", { name: "Publish", exact: true }).click();
    const failure = page.locator(".notice").filter({ hasText: "Published Publish retry" });
    await expect(failure).toContainText("Couldn't copy the link");
    await expect(failure).toContainText("Publishing in Companion settings");
    await expect(failure).not.toContainText("link copied");
    await expect.poll(items).toEqual([expect.objectContaining({ key: "Publish retry.md", gistId: "g1" })]);
    const [published] = await items();
    await page.screenshot({ path: testInfo.outputPath("published-with-clipboard-failure.png") });
    await run("copy-published-link");
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).clipboardProbe!.attempts.length)).toBe(2);
    await expect(page.locator(".notice").last()).toContainText("Couldn't copy the link");
    await expect(page.locator(".notice").last()).not.toContainText("Link copied");
    await rig.reloadPlugin();
    expect(await items()).toEqual([published]);
    await page.evaluate(() => { (window as unknown as AppWindow).clipboardProbe!.reject = false; });
    await run("copy-published-link");
    await expect(page.locator(".notice").last()).toHaveText(`Link copied:\n${published!.url}`);
    expect(await page.evaluate(() => (window as unknown as AppWindow).clipboardProbe!.attempts)).toEqual([published!.url, published!.url, published!.url]);
    expect((await rig.githubRequests()).map(({ method, path }) => ({ method, path }))).toEqual([{ method: "POST", path: "/gists" }]);
    expect(await readFile(join(rig.paths.vault, "Publish retry.md"), "utf8")).toBe(note);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => { const w = window as unknown as AppWindow; w.clipboardProbe?.restore(); delete w.clipboardProbe; });
  }
});
