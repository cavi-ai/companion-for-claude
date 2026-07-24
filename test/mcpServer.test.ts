// End-to-end test of the MCP bridge over a real HTTP socket: boots the actual
// McpHttpServer, wires it to VaultTools backed by an in-memory vault (the
// "obsidian" import is aliased to test/fakes/obsidian.ts), and drives the real
// JSON-RPC handshake + tool calls with fetch — exactly as Claude Code / Claude
// Desktop would over the http transport.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { App } from "obsidian";
import { McpHttpServer } from "../src/mcp/server";
import { VaultTools } from "../src/mcp/vaultTools";
import { MCP_PROTOCOL_VERSION, RPC } from "../src/mcp/protocol";

const TOKEN = "test-secret-token";

let app: App;
let server: McpHttpServer;
let base: string;

beforeAll(async () => {
  app = new App();
  // Seed a small vault.
  app.vault.seed("Notes/Welcome.md", "# Welcome\nThis vault talks about pelican migration patterns.", { tags: ["intro"] });
  app.vault.seed("Notes/Other.md", "Unrelated content about databases.", { mtime: Date.now() - 60_000 });

  const tools = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude" });
  server = new McpHttpServer({ port: 0, token: TOKEN, serverInfo: { name: "obsidian-vault", version: "0.4.0" } }, tools);
  await server.start();
  const addr = server.address();
  if (!addr) throw new Error("server did not bind");
  base = `http://127.0.0.1:${addr.port}/mcp`;
});

afterAll(async () => {
  await server.stop();
});

/** POST a JSON-RPC payload with the bearer token (unless overridden). */
async function rpc(body: unknown, opts: { token?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(name: string, args: Record<string, unknown>, id = 99): Promise<{ text?: string; isError?: boolean; error?: { code: number } }> {
  const res = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const json = (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
  return { text: json.result?.content?.[0]?.text, isError: json.result?.isError, error: json.error };
}

describe("MCP bridge — transport & auth", () => {
  it("rejects requests without a bearer token (401)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token (401)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "nope" });
    expect(res.status).toBe(401);
  });

  it("refuses to start without a bearer token", async () => {
    const app2 = new App();
    const tools = new VaultTools(app2 as never, { allowWrites: false, defaultFolder: "Claude" });
    const tokenless = new McpHttpServer({ port: 0, token: "", serverInfo: { name: "obsidian-vault", version: "0.4.0" } }, tools);
    await expect(tokenless.start()).rejects.toThrow(/token/i);
  });

  it("answers a CORS preflight with 204", async () => {
    const res = await fetch(base, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("404s for non-/mcp paths", async () => {
    const res = await fetch(base.replace("/mcp", "/elsewhere"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("serves a GET liveness probe", async () => {
    const res = await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; server: { name: string } };
    expect(json.status).toBe("ok");
    expect(json.server.name).toBe("obsidian-vault");
  });

  it("reports a JSON parse error per JSON-RPC", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{ not json",
    });
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(RPC.PARSE_ERROR);
  });
});

describe("MCP bridge — handshake & discovery", () => {
  it("completes the initialize handshake", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } });
    const json = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(json.result.serverInfo.name).toBe("obsidian-vault");
    expect(json.result.capabilities).toBeDefined();
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists vault tools including write tools when writes are allowed", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const json = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = json.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["vault_search", "note_read", "list_recent", "vault_tags", "note_create", "note_append"]));
    expect(names).not.toContain("research_evidence_create");
    expect(names).not.toContain("research_outline_create");
  });

  it("tracks handled requests for the status UI", async () => {
    const before = server.stats();
    const res = await rpc({ jsonrpc: "2.0", id: 22, method: "tools/list" });
    const json = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(json.result.tools.length).toBeGreaterThan(0);
    const after = server.stats();
    expect(after.handledRequests).toBeGreaterThan(before.handledRequests);
    expect(after.activeRequests).toBe(0);
  });
});

describe("MCP bridge — vault tools over the wire", () => {
  it("vault_search finds the seeded note by keyword", async () => {
    const r = await call("vault_search", { query: "pelican migration" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Notes/Welcome.md");
  });

  it("note_read returns the full note content", async () => {
    const r = await call("note_read", { path: "Notes/Welcome.md" });
    expect(r.text).toContain("pelican migration patterns");
  });

  it("note_read on a missing path surfaces a tool error (not a transport error)", async () => {
    const r = await call("note_read", { path: "Nope/Missing.md" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found");
  });

  it("note_append writes through and is observable via note_read (round trip)", async () => {
    const append = await call("note_append", { path: "Notes/Welcome.md", content: "- [x] Tracked task" });
    expect(append.isError).toBe(false);
    const read = await call("note_read", { path: "Notes/Welcome.md" });
    expect(read.text).toContain("- [x] Tracked task");
  });

  it("list_recent orders by modified time (most recent first)", async () => {
    const r = await call("list_recent", { limit: 5 });
    const lines = (r.text ?? "").split("\n");
    expect(lines[0]).toContain("Notes/Welcome.md");
  });

  it("supports JSON-RPC batches", async () => {
    const res = await rpc([
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { jsonrpc: "2.0", id: 11, method: "tools/list" },
    ]);
    const json = (await res.json()) as Array<{ id: number }>;
    expect(json).toHaveLength(2);
    expect(json.map((r) => r.id).sort()).toEqual([10, 11]);
  });

  it("executes both hidden research compatibility aliases without advertising them", async () => {
    const project = JSON.parse((await call("research_project_create", {
      title: "Compatibility",
      question: "Do legacy clients keep working?",
      folder: "Research/Compatibility",
    })).text ?? "{}").path as string;
    const source = JSON.parse((await call("research_source_import", {
      project,
      title: "Legacy source",
      source_kind: "web",
      url: "https://example.test/legacy",
      captured_text: "A stable result.",
    })).text ?? "{}").path as string;

    const evidence = await call("research_evidence_create", {
      project,
      source,
      title: "Legacy evidence",
      excerpt: "A stable result.",
    });
    expect(evidence.isError).toBe(false);
    expect(JSON.parse(evidence.text ?? "{}").path).toContain("Research/Compatibility/Evidence/");

    const outline = await call("research_outline_create", { project, claims: [] });
    expect(outline.isError).toBe(false);
    expect(JSON.parse(outline.text ?? "{}").path).toBe("Research/Compatibility/Documents/Outline.md");
  });

  it("still rejects an unrelated unadvertised tool as method-not-found", async () => {
    const result = await call("research_unadvertised_unknown", {});
    expect(result.error?.code).toBe(RPC.METHOD_NOT_FOUND);
  });
});

describe("MCP bridge — write gating", () => {
  it("hides and refuses write tools when allowWrites is false", async () => {
    const app2 = new App();
    app2.vault.seed("A.md", "hello");
    const ro = new VaultTools(app2 as never, { allowWrites: false, defaultFolder: "Claude" });
    const s2 = new McpHttpServer({ port: 0, token: TOKEN, serverInfo: { name: "obsidian-vault", version: "0.4.0" } }, ro);
    await s2.start();
    try {
      const url = `http://127.0.0.1:${s2.address()?.port}/mcp`;
      const list = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
      expect(names).not.toContain("note_create");

      // Even if called directly, the tool refuses.
      const callRes = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "note_create", arguments: { title: "x", content: "y" } } }) });
      const json = (await callRes.json()) as { error?: { code: number } };
      // Unknown to the (read-only) registry → method-not-found.
      expect(json.error?.code).toBe(RPC.METHOD_NOT_FOUND);
    } finally {
      await s2.stop();
    }
  });

  it("routes hidden research aliases through the disabled-write gate", async () => {
    const app2 = new App();
    const ro = new VaultTools(app2 as never, { allowWrites: false, defaultFolder: "Claude" });
    const s2 = new McpHttpServer({ port: 0, token: TOKEN, serverInfo: { name: "obsidian-vault", version: "0.4.0" } }, ro);
    await s2.start();
    try {
      const url = `http://127.0.0.1:${s2.address()?.port}/mcp`;
      for (const name of ["research_evidence_create", "research_outline_create"]) {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }),
        });
        const json = (await response.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
        expect(json.error).toBeUndefined();
        expect(json.result?.isError).toBe(true);
        expect(json.result?.content?.[0]?.text).toMatch(/write tools.*disabled/i);
      }
    } finally {
      await s2.stop();
    }
  });
});
