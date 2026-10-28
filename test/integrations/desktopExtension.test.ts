import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import manifestSchema from "../fixtures/mcpb/manifest-v0.3.schema.json";
import {
  EXTENSION_VERSION,
  PROXY_SOURCE,
  buildExtensionBundle,
  connectionFileBody,
  connectionFilePath,
  connectorScriptPath,
  extensionManifest,
  refreshedConnectionBody,
  withoutLegacyBridgeEntry,
} from "../../src/integrations/desktopExtension";

// The published JSON Schema omits MCPB's runtime version-presence refinement.
const validateManifest = addFormats(new Ajv({ allErrors: false })).compile({
  ...manifestSchema,
  anyOf: [{ required: ["manifest_version"] }, { required: ["dxt_version"] }],
});

describe("Claude Desktop extension bundle", () => {
  it("carries a manifest the official MCPB 0.3 schema accepts", () => {
    const valid = validateManifest(extensionManifest(EXTENSION_VERSION));
    expect(validateManifest.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("also accepts the legacy version marker", () => {
    const { manifest_version, ...manifest } = extensionManifest(EXTENSION_VERSION);
    expect(validateManifest({ ...manifest, dxt_version: manifest_version })).toBe(true);
  });

  it.each([
    { manifest_version: undefined },
    { manifest_version: "0.2" },
    { unexpected: true },
    { server: { type: "node" } },
    { author: { name: "Example", url: "invalid-url" } },
    { tools: [{ name: 123 }] },
  ])("rejects an invalid manifest: %j", (invalid) => {
    expect(validateManifest({ ...extensionManifest(EXTENSION_VERSION), ...invalid })).toBe(false);
  });

  it("stops reporting errors at the first invalid tool in an oversized list", () => {
    const tools = Array.from({ length: 10_000 }, () => ({ name: 123 }));
    let laterReads = 0;
    Object.defineProperty(tools, 1, { get: () => { laterReads++; return { name: 123 }; } });
    expect(validateManifest({
      ...extensionManifest(EXTENSION_VERSION),
      tools,
    })).toBe(false);
    expect(validateManifest.errors).toHaveLength(1);
    expect(laterReads).toBe(0);
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
    expect(connectorScriptPath("darwin", "/Users/me", {})).toBe("/Users/me/Library/Application Support/Companion for Claude/server/index.js");
    expect(connectorScriptPath("win32", "C:\\Users\\me", {})).toBe("C:\\Users\\me\\AppData\\Roaming\\Companion for Claude\\server\\index.js");
    expect(JSON.parse(connectionFileBody("http://127.0.0.1:1/mcp", "t"))).toEqual({ url: "http://127.0.0.1:1/mcp", token: "t" });
    expect(JSON.parse(connectionFileBody("http://127.0.0.1:1/mcp", "t", { name: "Notes", path: "/v/Notes" })))
      .toEqual({ url: "http://127.0.0.1:1/mcp", token: "t", vault: "Notes", vaultPath: "/v/Notes" });
  });
});

describe("refreshedConnectionBody", () => {
  const vault = { name: "Notes", path: "/v/Notes" };
  const owned = connectionFileBody("http://127.0.0.1:22360/mcp", "old", vault);

  it("moves a file this vault owns to the bridge's current address and token", () => {
    expect(JSON.parse(refreshedConnectionBody(owned, "http://127.0.0.1:22361/mcp", "new", vault)!))
      .toEqual({ url: "http://127.0.0.1:22361/mcp", token: "new", vault: "Notes", vaultPath: "/v/Notes" });
  });

  it("leaves a current file, another vault's file, an unclaimed file and a missing or broken file alone", () => {
    expect(refreshedConnectionBody(owned, "http://127.0.0.1:22360/mcp", "old", vault)).toBeNull();
    expect(refreshedConnectionBody(owned, "http://127.0.0.1:1/mcp", "new", { name: "Other", path: "/v/Other" })).toBeNull();
    expect(refreshedConnectionBody(connectionFileBody("http://127.0.0.1:22360/mcp", "old"), "http://127.0.0.1:1/mcp", "new", vault)).toBeNull();
    expect(refreshedConnectionBody(null, "http://127.0.0.1:1/mcp", "new", vault)).toBeNull();
    expect(refreshedConnectionBody("{", "http://127.0.0.1:1/mcp", "new", vault)).toBeNull();
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

const TOOLS = [{ name: "vault_search", inputSchema: { type: "object" } }];

/**
 * A stand-in for Companion's bridge: JSON replies, a session id, 202 for notifications, 404 for an unknown session.
 * `afterInitialized` runs once the handshake's notification is answered, so a test can change the bridge at a
 * known point instead of guessing at timing.
 */
function bridge(accepted: { token: string }, afterInitialized?: () => void, toolReplyOrder?: readonly string[]) {
  const sessions = new Set<string>();
  const seen: Array<{ method: string; session: string | undefined; auth: string | undefined }> = [];
  const toolReplies = new Map<string, () => void>();
  let next = 1;
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number | string; method: string };
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
      const result = message.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: "Notes/Heron.md" }], isError: false };
      const reply = () => res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (toolReplyOrder?.includes(message.method)) {
        toolReplies.set(message.method, reply);
        if (toolReplyOrder.every((method) => toolReplies.has(method))) {
          for (const method of toolReplyOrder) toolReplies.get(method)!();
        }
      } else reply();
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
function home(connection?: { url: string; token: string; vault?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "companion-home-"));
  const file = connectionFilePath(process.platform === "win32" ? "win32" : "darwin", dir, { APPDATA: join(dir, "AppData") });
  const write = (value: { url: string; token: string; vault?: string }) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, connectionFileBody(value.url, value.token, value.vault ? { name: value.vault, path: `/v/${value.vault}` } : undefined));
  };
  if (connection) write(connection);
  return {
    env: { HOME: dir, USERPROFILE: dir, APPDATA: join(dir, "AppData") } as Record<string, string>,
    file,
    tools: join(dirname(file), "tools.json"),
    write,
  };
}

/** A stand-in for macOS `open` on PATH: records its arguments, optionally copies a connection file into place, exits with `code`. */
function opener(code: number, copy?: { from: string; to: string }) {
  const dir = mkdtempSync(join(tmpdir(), "companion-open-"));
  const record = join(dir, "args.txt");
  const lines = ["#!/bin/sh", `printf '%s\\n' "$@" > '${record}'`];
  if (copy) lines.push(`cp '${copy.from}' '${copy.to}'`);
  lines.push(`exit ${code}`);
  writeFileSync(join(dir, "open"), `${lines.join("\n")}\n`);
  chmodSync(join(dir, "open"), 0o755);
  return { path: `${dir}${delimiter}${process.env.PATH ?? ""}`, args: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : []) };
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
const CALL = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_search", arguments: { query: "heron" } } };
const CLOSED = "http://127.0.0.1:9/mcp";

describe("Claude Desktop extension proxy", () => {
  let server: ReturnType<typeof bridge> | null = null;
  afterEach(async () => { await server?.close(); server = null; });

  it("answers the handshake and lists the saved tools while Obsidian is closed", async () => {
    const user = home({ url: CLOSED, token: "tok" });
    writeFileSync(user.tools, JSON.stringify(TOOLS));
    const replies = await runProxy(user.env, [INIT, INITIALIZED, LIST]);
    expect(replies[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "obsidian-vault", version: EXTENSION_VERSION }, capabilities: { tools: { listChanged: true } } } });
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } });
  });

  it.each([
    { order: ["tools/list", "tools/call"] },
    { order: ["tools/call", "tools/list"] },
  ])("relays requests on its own bridge session and saves the tool list ($order)", async ({ order }) => {
    server = bridge({ token: "tok" }, undefined, order);
    const url = await server.listen();
    const user = home({ url, token: "tok" });
    const replies = await runProxy(user.env, [INIT, INITIALIZED, LIST, CALL]);
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(replies.find((r) => r.id === 2)!.result).toEqual({ tools: TOOLS });
    expect(replies.find((r) => r.id === 3)!.result.content[0].text).toBe("Notes/Heron.md");
    expect(server.seen.slice(0, 2)).toEqual([
      { method: "initialize", session: undefined, auth: "Bearer tok" },
      { method: "notifications/initialized", session: "s1", auth: "Bearer tok" },
    ]);
    expect(server.seen.slice(2)).toHaveLength(2);
    expect(server.seen.slice(2)).toEqual(expect.arrayContaining([
      { method: "tools/list", session: "s1", auth: "Bearer tok" },
      { method: "tools/call", session: "s1", auth: "Bearer tok" },
    ]));
    expect(JSON.parse(readFileSync(user.tools, "utf8"))).toEqual(TOOLS);
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
    expect(replies[1]!.result).toEqual({ tools: TOOLS });
    expect(server.seen.at(-1)).toMatchObject({ method: "tools/list", auth: "Bearer new" });
  });

  it.skipIf(process.platform === "win32")("opens the vault in Obsidian when a tool is called while it is closed, then answers through its bridge", async () => {
    server = bridge({ token: "tok" });
    const url = await server.listen();
    const user = home({ url: CLOSED, token: "tok", vault: "Field Notes" });
    writeFileSync(user.tools, JSON.stringify(TOOLS));
    // Obsidian starting: Companion's bridge comes up and Companion rewrites the connection file.
    const started = join(dirname(user.file), "started.json");
    writeFileSync(started, connectionFileBody(url, "tok", { name: "Field Notes", path: "/v/Field Notes" }));
    const open = opener(0, { from: started, to: user.file });
    const replies = await runProxy({ ...user.env, PATH: open.path }, [INIT, INITIALIZED, LIST, CALL]);
    expect(open.args()).toEqual(["-g", "obsidian://open?vault=Field%20Notes"]);
    expect(replies.find((r) => r.id === 3)!.result).toEqual({ content: [{ type: "text", text: "Notes/Heron.md" }], isError: false });
    expect(replies).toContainEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });

  it.skipIf(process.platform === "win32")("answers a tool call with what to do when Obsidian cannot be opened", async () => {
    const user = home({ url: CLOSED, token: "tok", vault: "Field Notes" });
    const open = opener(1);
    const replies = await runProxy({ ...user.env, PATH: open.path }, [INIT, CALL]);
    expect(replies[1]).toMatchObject({ id: 3, result: { isError: true, content: [{ type: "text", text: expect.stringContaining("Obsidian could not be opened") }] } });
  });

  it("answers tool calls with what to do: no connection file, a rejected token", async () => {
    const missing = await runProxy(home().env, [INIT, CALL]);
    expect(missing[0]!.result.serverInfo.name).toBe("obsidian-vault");
    expect(missing[1]).toMatchObject({ id: 3, result: { isError: true, content: [{ text: expect.stringContaining("click Connect Claude Desktop") }] } });
    server = bridge({ token: "tok" });
    const url = await server.listen();
    const wrong = await runProxy(home({ url, token: "nope" }).env, [INIT, CALL]);
    expect(wrong[1]).toMatchObject({ id: 3, result: { isError: true, content: [{ text: expect.stringContaining("rejected the token") }] } });
  });
});
