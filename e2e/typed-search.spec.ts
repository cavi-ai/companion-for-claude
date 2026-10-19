import { createServer } from "node:net";
import { expect, test } from "./fixtures";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return reject(new Error("No port")); s.close(() => resolve(a.port)); });
  });
}

type PageApp = {
  vault: { getAbstractFileByPath(path: string): unknown };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: { type?: unknown } } | null };
  commands: { executeCommandById(id: string): Promise<void> };
  plugins: { plugins: Record<string, { syncMcpServer(): Promise<void>; resolvedMcpToken(): string }> };
};

test("vault_search with a type filter matches notes of its subtypes over the live bridge", async ({ rig }) => {
  const port = await freePort();
  const harness = await rig.reset({
    settingsOverride: { mcpEnabled: true, mcpPort: port, mcpAllowWrites: false, mcpToken: "7a1c3e5b9d2f4a6c8e0b1d3f5a7c9e2b" },
    extraFiles: {
      "Clips/Heron.md": "---\ntype: article\n---\nheron migration notes",
      "People/Heron Watcher.md": "---\ntype: person\n---\nheron watcher",
      "Notes/Loose.md": "heron loose",
    },
  });
  const { page } = harness;
  try {
    await page.evaluate(() => (window as unknown as { app: PageApp }).app.commands.executeCommandById("claude-companion:seed-ontology"));
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as { app: PageApp }).app;
      return Boolean(app.vault.getAbstractFileByPath("Ontology/article.md") && app.vault.getAbstractFileByPath("Ontology/source.md"));
    }), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as { app: PageApp }).app;
      return app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Clips/Heron.md"))?.frontmatter?.type;
    }), { timeout: 15_000 }).toBe("article");

    const bearer = await page.evaluate(async () => {
      const plugin = (window as unknown as { app: PageApp }).app.plugins.plugins["claude-companion"]!;
      await plugin.syncMcpServer();
      return plugin.resolvedMcpToken();
    });
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });

    const search = await rpc("tools/call", { name: "vault_search", arguments: { query: "heron", type: "source" } });
    const text = JSON.stringify(search.result);
    expect(text).toContain("Clips/Heron.md");
    expect(text).not.toContain("Heron Watcher");
    expect(text).not.toContain("Loose");
  } finally {
    await harness.close();
  }
});
