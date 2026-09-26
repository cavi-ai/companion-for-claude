import { createServer } from "node:net";
import { expect, test } from "./fixtures";
import type { Rig } from "./fixtures";

test.describe.configure({ mode: "serial" });
let harness: Rig;
let port = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return reject(new Error("No port")); s.close(() => resolve(a.port)); });
  });
}

test.beforeAll(async ({ rig }) => {
  port = await freePort();
  harness = await rig.reset({
    embedStub: true,
    settingsOverride: { mcpEnabled: true, mcpPort: port, mcpAllowWrites: false, mcpToken: "3f9c1b7e2a6d4c8f9e0b1a2c3d4e5f61" },
    extraFiles: {
      "Research/Alpha/Evidence/E1.md": "---\ntype: research-evidence\nproject: \"[[Research/Alpha/Project.md]]\"\n---\npelican evidence alpha",
      "Research/Beta/Evidence/E2.md": "---\ntype: research-evidence\nproject: \"[[Research/Beta/Project.md]]\"\n---\npelican evidence beta",
      "Notes/Loose.md": "pelican pelican pelican loose",
      "Claude/Sessions/What Claude Knows.md": "# What Claude Knows\n- e2e memory",
    },
  });
});
test.afterAll(async () => { await harness?.close(); });

async function token(): Promise<string> {
  return harness.page.evaluate(async () => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { syncMcpServer(): Promise<void>; rebuildSemanticIndex(): Promise<void>; resolvedMcpToken(): string }> } } }).app.plugins.plugins["claude-companion"];
    await plugin.syncMcpServer();
    await plugin.rebuildSemanticIndex();
    return plugin.resolvedMcpToken();
  });
}

test("typed search, related notes and substrate resources over the live bridge", async () => {
  const bearer = await token();
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });

  const search = await rpc("tools/call", { name: "vault_search", arguments: { query: "pelican", type: "research-evidence", project: "Alpha/Project" } });
  const searchText = JSON.stringify(search.result);
  expect(searchText).toContain("Research/Alpha/Evidence/E1.md");
  expect(searchText).not.toContain("Beta");
  expect(searchText).not.toContain("Loose");

  const related = await rpc("tools/call", { name: "related_notes", arguments: { path: "Research/Alpha/Evidence/E1.md" } });
  const relatedText = JSON.stringify(related.result);
  expect(relatedText).toMatch(/similarity \d\.\d\d/);
  expect(relatedText).toContain("Research/Beta/Evidence/E2.md");

  const list = await rpc("resources/list");
  expect(JSON.stringify(list.result)).toContain("obsidian://memory");
  const templates = await rpc("resources/templates/list");
  expect(JSON.stringify(templates.result)).toContain("obsidian://research/{project}");
  const memory = await rpc("resources/read", { uri: "obsidian://memory" });
  expect(JSON.stringify(memory.result)).toContain("e2e memory");
});
