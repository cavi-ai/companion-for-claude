import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type Published = { key: string; kind: string; gistId: string; url: string };
type AppWindow = { app: {
  workspace: { openLinkText(path: string, source: string, newLeaf: boolean, state?: unknown): Promise<void> };
  plugins: { plugins: Record<string, { settings: { publishApiBase: string }; saveSettings(): Promise<void>; publishing(): { publishedItems(): Published[] } }> };
} };

test("different artifacts with the same title publish independently while repeated clicks are ignored", async ({ rig }, testInfo) => {
  const { githubPort } = await rig.control.ports();
  const requests: Array<{ method: string; path: string; body: string }> = [];
  let held: (() => void) | undefined;
  const release = () => { const respond = held; held = undefined; respond?.(); };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", path: request.url ?? "", body });
      const id = `g${requests.length}`;
      const respond = () => { response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ id, html_url: `https://gist.github.com/e2e/${id}`, owner: { login: "e2e" } })); };
      if (requests.length === 1) held = respond;
      else respond();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let page: Page | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Artifact publishing stub did not bind");
    const note = ["# Comparison charts", "", "```claude-html", "<html><head><title>Chart</title></head><body><h1>First result</h1><p>Result A.</p></body></html>", "```", "", "```claude-html", "<html><head><title>Chart</title></head><body><h1>Second result</h1><p>Result B.</p></body></html>", "```", ""].join("\n");
    ({ page } = await rig.reset({ extraFiles: { "Comparison charts.md": note }, settingsOverride: { publishApiBase: `http://127.0.0.1:${address.port}`, publishGithubToken: "e2e-gist-token" } }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(async () => { await (window as unknown as AppWindow).app.workspace.openLinkText("Comparison charts", "", false, { state: { mode: "preview" } }); });
    const buttons = page.locator(".markdown-reading-view").getByRole("button", { name: "Publish to GitHub Gist", exact: true });
    await expect(buttons).toHaveCount(2);
    await buttons.nth(0).click();
    await page.locator(".modal").getByRole("button", { name: "Publish", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await buttons.nth(0).click();
    await expect(page.locator(".modal")).toHaveCount(0);
    await buttons.nth(1).click();
    await expect(page.locator(".modal")).toContainText("Publish Chart to GitHub Gist?");
    await page.screenshot({ path: testInfo.outputPath("second-artifact-can-publish-while-first-is-pending.png"), animations: "disabled" });
    await page.locator(".modal").getByRole("button", { name: "Publish", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    release();
    await expect(page.locator(".notice").filter({ hasText: "Published Chart" })).toHaveCount(2);
    const published = () => rig.page.evaluate(() => (window as unknown as AppWindow).app.plugins.plugins["claude-companion"]!.publishing().publishedItems());
    const items = await published();
    expect(items).toHaveLength(2);
    expect(items.map(({ gistId }) => gistId).sort()).toEqual(["g1", "g2"]);
    expect(items.every(({ kind }) => kind === "artifact")).toBe(true);
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([{ method: "POST", path: "/gists" }, { method: "POST", path: "/gists" }]);
    const content = (body: string) => (JSON.parse(body) as { files: Record<string, { content: string }> }).files["index.html"]!.content;
    expect(content(requests[0]!.body)).toContain("Result A.");
    expect(content(requests[1]!.body)).toContain("Result B.");
    await rig.reloadPlugin();
    expect(await published()).toEqual(items);
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
