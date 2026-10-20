import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { McpbManifestSchema } from "@anthropic-ai/mcpb/schemas/0.3";
import {
  EXTENSION_VERSION,
  PROXY_SOURCE,
  buildExtensionBundle,
  connectionFileBody,
  connectionFilePath,
  extensionManifest,
  withoutLegacyBridgeEntry,
} from "../../src/integrations/desktopExtension";

describe("Claude Desktop extension bundle", () => {
  it("carries a manifest the official MCPB 0.3 schema accepts", () => {
    const parsed = McpbManifestSchema.safeParse(extensionManifest(EXTENSION_VERSION));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("zips the manifest and the proxy at the root and asks for no settings at install", () => {
    const files = unzipSync(buildExtensionBundle(EXTENSION_VERSION));
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "server/index.js"]);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as Record<string, any>;
    expect(manifest.server.mcp_config).toEqual({ command: "node", args: ["${__dirname}/server/index.js"] });
    expect(manifest.user_config).toBeUndefined();
    expect(strFromU8(files["server/index.js"]!)).toBe(PROXY_SOURCE);
  });

  it("puts the connection file in the platform's per-user application data", () => {
    expect(connectionFilePath("darwin", "/Users/me/", {})).toBe("/Users/me/Library/Application Support/Companion for Claude/bridge.json");
    expect(connectionFilePath("win32", "C:\\Users\\me", { APPDATA: "C:\\Users\\me\\AppData\\Roaming\\" }))
      .toBe("C:\\Users\\me\\AppData\\Roaming\\Companion for Claude\\bridge.json");
    expect(connectionFilePath("win32", "C:\\Users\\me", {})).toBe("C:\\Users\\me\\AppData\\Roaming\\Companion for Claude\\bridge.json");
    expect(JSON.parse(connectionFileBody("http://127.0.0.1:1/mcp", "t"))).toEqual({ url: "http://127.0.0.1:1/mcp", token: "t" });
  });
});

describe("withoutLegacyBridgeEntry", () => {
  const legacy = { command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:22360/mcp", "--header", "Authorization: Bearer secret"] };

  it("removes only the mcp-remote entry earlier versions wrote and keeps everything else", () => {
    const source = JSON.stringify({ theme: "dark", mcpServers: { keep: { command: "keep" }, "obsidian-vault": legacy } });
    expect(JSON.parse(withoutLegacyBridgeEntry(source)!)).toEqual({ theme: "dark", mcpServers: { keep: { command: "keep" } } });
  });

  it("never touches a config Companion did not write", () => {
    expect(withoutLegacyBridgeEntry(null)).toBeNull();
    expect(withoutLegacyBridgeEntry("{")).toBeNull();
    expect(withoutLegacyBridgeEntry(JSON.stringify({ mcpServers: { keep: { command: "keep" } } }))).toBeNull();
    expect(withoutLegacyBridgeEntry(JSON.stringify({ mcpServers: { "obsidian-vault": { command: "node", args: ["vault.js"] } } }))).toBeNull();
    expect(withoutLegacyBridgeEntry(JSON.stringify({ mcpServers: { "obsidian-vault": { ...legacy, args: ["-y", "mcp-remote", "https://example.com/mcp"] } } }))).toBeNull();
  });
});

/**
 * A stand-in for Companion's bridge: JSON replies, a session id, 202 for notifications, 404 for an unknown session.
 * `afterInitialized` runs once the handshake's notification is answered, so a test can change the bridge at a
 * known point instead of guessing at timing.
 */
function bridge(accepted: { token: string }, afterInitialized?: () => void) {
  const sessions = new Set<string>();
  const seen: Array<{ method: string; session: string | undefined; auth: string | undefined }> = [];
  let next = 1;
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      const session = req.headers["mcp-session-id"] as string | undefined;
      seen.push({ method: message.method, session, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${accepted.token}`) { res.writeHead(401).end("{}"); return; }
      if (message.method === "initialize") {
        const id = `s${next++}`;
        sessions.add(id);
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "obsidian-vault" } } }, null, 2));
        return;
      }
      if (!session || !sessions.has(session)) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown session"}'); return; }
      if (message.id === undefined) {
        res.writeHead(202).end();
        if (message.method === "notifications/initialized") afterInitialized?.();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "vault_search" }] } }));
    });
  });
  return {
    seen,
    forget: () => sessions.clear(),
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`);
    })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const proxyFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), "companion-proxy-"));
  const file = join(dir, "index.js");
  writeFileSync(file, PROXY_SOURCE);
  return file;
})();

/** A home folder holding Companion's connection file, as the proxy finds it on this platform. */
function home(connection?: { url: string; token: string }) {
  const dir = mkdtempSync(join(tmpdir(), "companion-home-"));
  const file = connectionFilePath(process.platform === "win32" ? "win32" : "darwin", dir, { APPDATA: join(dir, "AppData") });
  const write = (value: { url: string; token: string }) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, connectionFileBody(value.url, value.token));
  };
  if (connection) write(connection);
  return { env: { HOME: dir, USERPROFILE: dir, APPDATA: join(dir, "AppData") }, write };
}

/** Run the proxy under plain node: send `lines` on stdin, close it, and collect each JSON line it prints. */
function runProxy(env: Record<string, string>, lines: unknown[]): Promise<Array<Record<string, any>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [proxyFile], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)));
    void (async () => {
      for (const line of lines) {
        child.stdin.write(`${JSON.stringify(line)}\n`);
        await new Promise((r) => setTimeout(r, 40));
      }
      child.stdin.end();
    })();
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

describe("Claude Desktop extension proxy", () => {
  let server: ReturnType<typeof bridge> | null = null;
  afterEach(async () => { await server?.close(); server = null; });

  it("reads Companion's connection file and relays initialize, a notification and a request as single JSON lines", async () => {
    server = bridge({ token: "tok" });
    const url = await server.listen();
    const replies = await runProxy(home({ url, token: "tok" }).env, [INIT, INITIALIZED, LIST]);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[1]!.result).toEqual({ tools: [{ name: "vault_search" }] });
    expect(server.seen).toEqual([
      { method: "initialize", session: undefined, auth: "Bearer tok" },
      { method: "notifications/initialized", session: "s1", auth: "Bearer tok" },
      { method: "tools/list", session: "s1", auth: "Bearer tok" },
    ]);
  });

  it("starts a new session and retries once when the bridge forgets the old one", async () => {
    // Obsidian restarting: the bridge forgets every session right after the handshake.
    server = bridge({ token: "tok" }, () => server?.forget());
    const url = await server.listen();
    const replies = await runProxy(home({ url, token: "tok" }).env, [INIT, INITIALIZED, LIST]);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(server.seen.map((s) => `${s.method}@${s.session ?? "-"}`)).toEqual([
      "initialize@-", "notifications/initialized@s1", "tools/list@s1", "initialize@-", "notifications/initialized@s2", "tools/list@s2",
    ]);
  });

  it("picks up a new token from the connection file without being reinstalled", async () => {
    const accepted = { token: "old" };
    let user: ReturnType<typeof home> | null = null;
    // Companion issuing a new token right after the handshake: the bridge and the connection file change together.
    server = bridge(accepted, () => { accepted.token = "new"; user?.write({ url, token: "new" }); });
    const url = await server.listen();
    user = home({ url, token: "old" });
    const replies = await runProxy(user.env, [INIT, INITIALIZED, LIST]);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[1]!.result).toBeDefined();
    expect(server.seen.at(-1)).toMatchObject({ method: "tools/list", auth: "Bearer new" });
  });

  it("answers each request with what to do: no connection file, a closed bridge, a rejected token", async () => {
    const missing = await runProxy(home().env, [INIT, INITIALIZED]);
    expect(missing).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: expect.stringContaining("click Connect Claude Desktop") } }]);
    const closed = await runProxy(home({ url: "http://127.0.0.1:9/mcp", token: "tok" }).env, [INIT]);
    expect(closed[0]!.error.message).toContain("not reachable at http://127.0.0.1:9/mcp");
    server = bridge({ token: "tok" });
    const url = await server.listen();
    const wrong = await runProxy(home({ url, token: "nope" }).env, [INIT]);
    expect(wrong[0]!.error.message).toContain("rejected the token");
  });
});
