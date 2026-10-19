import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type Published = { key: string; title: string; gistId: string; url: string; publishedAt: number };
type AppWindow = { app: {
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>; getActiveFile(): { path: string } | null };
  commands: { executeCommandById(id: string): void };
  plugins: { plugins: Record<string, { settings: { publishApiBase: string }; saveSettings(): Promise<void>; publishing(): { publishedItems(): Published[] } }> };
} };

test("note publications and removals follow renames while requests are pending", async ({ rig }, testInfo) => {
  const { githubPort } = await rig.control.ports();
  const requests: Array<{ method: string; path: string }> = [];
  let hold = true;
  let held: (() => void) | undefined;
  const release = () => { const respond = held; held = undefined; respond?.(); };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({ method: request.method ?? "", path: request.url ?? "" });
      const respond = () => {
        if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
        response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "g1", html_url: "https://gist.github.com/e2e/g1", owner: { login: "e2e" } }));
      };
      if (hold) held = respond;
      else respond();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let page: Page | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Publishing stub did not bind");
    ({ page } = await rig.reset({ extraFiles: { "Sharing draft.md": "# Sharing draft\n\nPublic explanation.\n" }, settingsOverride: { publishApiBase: `http://127.0.0.1:${address.port}`, publishGithubToken: "e2e-gist-token" } }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const command = (id: string) => rig.page.evaluate((value) => (window as unknown as AppWindow).app.commands.executeCommandById(`claude-companion:${value}`), id);
    const published = () => rig.page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.publishing().publishedItems());
    const rename = async (title: string) => {
      await rig.page.locator(".inline-title").fill(title);
      await rig.page.locator(".inline-title").press("Enter");
      await expect.poll(() => rig.page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(`${title}.md`);
    };
    await page.evaluate(() => (window as unknown as AppWindow).app.workspace.openLinkText("Sharing draft", "", false));
    await command("publish-note");
    await page.locator(".modal").getByRole("button", { name: "Publish", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await rename("Sharing revised");
    await rename("Sharing final");
    await command("publish-note");
    await expect(page.locator(".modal")).toHaveCount(0);
    expect(requests).toHaveLength(1);
    release();
    await expect(page.locator(".notice").filter({ hasText: "Published Sharing final" })).toBeVisible();
    const [first] = await published();
    expect(first).toMatchObject({ key: "Sharing final.md", title: "Sharing final", gistId: "g1" });
    await command("publish-note");
    await expect.poll(() => requests.length).toBe(2);
    await rename("Sharing approved");
    await command("publish-note");
    expect(requests).toHaveLength(2);
    release();
    await expect(page.locator(".notice").filter({ hasText: "Published Sharing approved" })).toBeVisible();
    const expected = [expect.objectContaining({ key: "Sharing approved.md", title: "Sharing approved", gistId: "g1", url: first!.url, publishedAt: first!.publishedAt })];
    expect(await published()).toEqual(expected);
    await page.screenshot({ path: testInfo.outputPath("publication-follows-renames.png"), animations: "disabled" });
    await rig.reloadPlugin();
    expect(await published()).toEqual(expected);
    hold = false;
    const approvedNotices = page.locator(".notice").filter({ hasText: "Published Sharing approved" });
    const priorNoticeCount = await approvedNotices.count();
    await command("publish-note");
    await expect.poll(() => requests.length).toBe(3);
    await expect(approvedNotices).toHaveCount(priorNoticeCount + 1);
    hold = true;
    await command("unpublish-note");
    await expect.poll(() => requests.length).toBe(4);
    await rename("Sharing archived");
    await command("unpublish-note");
    expect(requests).toHaveLength(4);
    release();
    await expect(page.locator(".notice").filter({ hasText: "Unpublished" })).toBeVisible();
    await rig.reloadPlugin();
    expect(await published()).toEqual([]);
    expect(requests).toEqual([{ method: "POST", path: "/gists" }, { method: "PATCH", path: "/gists/g1" }, { method: "PATCH", path: "/gists/g1" }, { method: "DELETE", path: "/gists/g1" }]);
    expect(errors).toEqual([]);
  } finally {
    release();
    try {
      if (page && !page.isClosed()) await page.evaluate(async (apiBase) => { const plugin = (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!; plugin.settings.publishApiBase = apiBase; await plugin.saveSettings(); }, `http://127.0.0.1:${githubPort}`);
    } finally {
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  }
});
