import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { buildExtensionBundle, connectionFileBody, connectionFilePath, EXTENSION_VERSION } from "../src/integrations/desktopExtension";
import { expect, test } from "./fixtures";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return reject(new Error("No port")); s.close(() => resolve(a.port)); });
  });
}

type PageApp = { plugins: { plugins: Record<string, { syncMcpServer(): Promise<void>; resolvedMcpToken(): string }> } };

/** Unpack the bundle Companion hands Claude Desktop and run its server the way Claude Desktop does: `node server/index.js`. */
function runExtension(bundle: Uint8Array, env: Record<string, string>, messages: unknown[]): Promise<Array<Record<string, any>>> {
  const dir = mkdtempSync(join(tmpdir(), "companion-extension-"));
  for (const [name, data] of Object.entries(unzipSync(bundle))) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), strFromU8(data));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, "server/index.js")], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)));
    void (async () => {
      for (const message of messages) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        await new Promise((r) => setTimeout(r, 150));
      }
      child.stdin.end();
    })();
  });
}

test("the Claude Desktop extension's server finds Companion's live bridge through the connection file", async ({ rig }) => {
  const port = await freePort();
  const harness = await rig.reset({
    settingsOverride: { mcpEnabled: true, mcpPort: port, mcpAllowWrites: false, mcpToken: "9b2d4f6a8c0e1b3d5f7a9c1e3b5d7f9a" },
    extraFiles: { "Notes/Heron.md": "Herons wade through the estuary at dawn." },
  });
  const { page } = harness;
  try {
    const token = await page.evaluate(async () => {
      const plugin = (window as unknown as { app: PageApp }).app.plugins.plugins["claude-companion"]!;
      await plugin.syncMcpServer();
      return plugin.resolvedMcpToken();
    });
    // The connection file Companion writes, in a throwaway home so the real one is never touched.
    const home = mkdtempSync(join(tmpdir(), "companion-home-"));
    const connection = connectionFilePath(process.platform === "win32" ? "win32" : "darwin", home, { APPDATA: join(home, "AppData") });
    mkdirSync(dirname(connection), { recursive: true });
    writeFileSync(connection, connectionFileBody(`http://127.0.0.1:${port}/mcp`, token));
    const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData") };
    const replies = await runExtension(buildExtensionBundle(EXTENSION_VERSION), env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_search", arguments: { query: "estuary" } } },
    ]);
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3]);
    expect(replies[0]!.result.serverInfo.name).toBe("obsidian-vault");
    expect((replies[1]!.result.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain("vault_search");
    expect(JSON.stringify(replies[2]!.result)).toContain("Notes/Heron.md");
  } finally {
    await harness.close();
  }
});

test("the extension starts while Obsidian is closed and answers a vault tool once Obsidian opens", async ({ rig }) => {
  test.skip(process.platform === "win32", "uses a stand-in for macOS open");
  const port = await freePort();
  const harness = await rig.reset({
    settingsOverride: { mcpEnabled: true, mcpPort: port, mcpAllowWrites: false, mcpToken: "4c6e8a0b2d4f6a8c0e1b3d5f7a9c1e3b" },
    extraFiles: { "Notes/Heron.md": "Herons wade through the estuary at dawn." },
  });
  const { page } = harness;
  try {
    const token = await page.evaluate(async () => {
      const plugin = (window as unknown as { app: PageApp }).app.plugins.plugins["claude-companion"]!;
      await plugin.syncMcpServer();
      return plugin.resolvedMcpToken();
    });
    const vault = { name: "Field Notes", path: "/vaults/Field Notes" };
    const home = mkdtempSync(join(tmpdir(), "companion-home-"));
    const connection = connectionFilePath(process.platform === "win32" ? "win32" : "darwin", home, { APPDATA: join(home, "AppData") });
    mkdirSync(dirname(connection), { recursive: true });
    // Obsidian closed: the connection file still names the port the bridge used last time.
    writeFileSync(connection, connectionFileBody("http://127.0.0.1:9/mcp", token, vault));
    // A stand-in for macOS open: records the URI, then does what Companion does once Obsidian is up.
    const bin = mkdtempSync(join(tmpdir(), "companion-open-"));
    const live = join(bin, "bridge.json");
    writeFileSync(live, connectionFileBody(`http://127.0.0.1:${port}/mcp`, token, vault));
    writeFileSync(join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(bin, "args.txt")}'\ncp '${live}' '${connection}'\n`);
    chmodSync(join(bin, "open"), 0o755);
    const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    const replies = await runExtension(buildExtensionBundle(EXTENSION_VERSION), env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_search", arguments: { query: "estuary" } } },
    ]);
    expect(replies.find((reply) => reply.id === 1)!.result.serverInfo.name).toBe("obsidian-vault");
    expect(replies.find((reply) => reply.id === 2)!.result).toEqual({ tools: [] });
    expect(existsSync(join(bin, "args.txt")) ? readFileSync(join(bin, "args.txt"), "utf8").trim().split("\n") : []).toEqual(["-g", "obsidian://open?vault=Field%20Notes"]);
    expect(JSON.stringify(replies.find((reply) => reply.id === 3)!.result)).toContain("Notes/Heron.md");
    expect(replies).toContainEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  } finally {
    await harness.close();
  }
});
