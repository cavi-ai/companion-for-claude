// The Claude Desktop extension (.mcpb) for Companion's vault bridge: a manifest
// plus a dependency-free stdio proxy that Claude Desktop runs on its built-in
// Node. The proxy reads the bridge address and token from a user-only
// connection file Companion writes outside the vault, so installing asks for
// nothing and a changed token or port is picked up without reinstalling. Pure.

import { strToU8, zipSync } from "fflate";
import { isRecord } from "../records";
import type { DesktopPlatform } from "./desktop";

/** Bundle file name; no spaces so every platform's opener takes it as one argument. */
export const EXTENSION_FILE_NAME = "companion-obsidian-vault.mcpb";
export const EXTENSION_NAME = "companion-obsidian-vault";
/** Version of the proxy and manifest; raise it when either changes so Claude Desktop offers the update. */
export const EXTENSION_VERSION = "1.1.0";
/** Folder of the connection file, under the platform's per-user application data. */
const CONNECTION_FOLDER = "Companion for Claude";
const CONNECTION_FILE = "bridge.json";

/** Where Companion writes the connection file the extension reads; the proxy derives the same path. */
export function connectionFilePath(platform: DesktopPlatform, homeDir: string, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.replace(/[\\/]+$/, "") || `${homeDir}\\AppData\\Roaming`;
    return `${appData}\\${CONNECTION_FOLDER}\\${CONNECTION_FILE}`;
  }
  return `${homeDir.replace(/\/+$/, "")}/Library/Application Support/${CONNECTION_FOLDER}/${CONNECTION_FILE}`;
}

/** The connection file's body: the bridge's MCP endpoint and its bearer token. */
export function connectionFileBody(url: string, token: string): string {
  return `${JSON.stringify({ url, token }, null, 2)}\n`;
}

/** MCP over stdio to Companion's loopback HTTP bridge. Runs under plain `node`; uses only built-ins. */
export const PROXY_SOURCE = String.raw`"use strict";
// Companion for Claude: MCP over stdio to Companion's vault bridge in Obsidian.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const CONNECTION_FILE = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "${CONNECTION_FOLDER}", "${CONNECTION_FILE}")
  : path.join(os.homedir(), "Library", "Application Support", "${CONNECTION_FOLDER}", "${CONNECTION_FILE}");
const CONNECT_HINT = "In Obsidian, open Companion's Desktop integrations and click Connect Claude Desktop.";
let connection = null;
let session = null;
let initRequest = null;
function readConnection() {
  try {
    const value = JSON.parse(fs.readFileSync(CONNECTION_FILE, "utf8"));
    connection = value && typeof value.url === "string" && typeof value.token === "string" && value.url && value.token ? value : null;
  } catch { connection = null; }
  return connection;
}
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const idsOf = (message) => (Array.isArray(message) ? message : [message])
  .map((m) => (m && typeof m === "object" ? m.id : undefined))
  .filter((id) => id !== undefined && id !== null);
const failAll = (message, text) => { for (const id of idsOf(message)) out({ jsonrpc: "2.0", id, error: { code: -32000, message: text } }); };
async function post(message) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + connection.token };
  if (session) headers["mcp-session-id"] = session;
  const response = await fetch(connection.url, { method: "POST", headers, body: JSON.stringify(message) });
  const id = response.headers.get("mcp-session-id");
  if (id) session = id;
  return response;
}
function emit(text, type) {
  const bodies = type.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  for (const body of bodies) {
    if (!body.trim()) continue;
    try { out(JSON.parse(body)); } catch { /* not JSON-RPC */ }
  }
}
async function reinitialize() {
  session = null;
  const response = await post(initRequest);
  await response.text();
  if (!response.ok) return false;
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
  return true;
}
async function send(message, isInit) {
  const response = await post(message);
  // The bridge forgets sessions when Obsidian restarts; start a new one and retry once.
  if (response.status === 404 && !isInit && initRequest) {
    await response.text();
    if (await reinitialize()) return post(message);
  }
  return response;
}
async function forward(message) {
  if (!connection && !readConnection()) return failAll(message, "Companion's connection file is missing. " + CONNECT_HINT);
  const isInit = !Array.isArray(message) && message && message.method === "initialize";
  if (isInit) { initRequest = message; session = null; }
  let response;
  try {
    response = await send(message, isInit);
  } catch {
    // The port may have changed since this connection was read; read it again before giving up.
    const before = connection.url;
    if (readConnection() && connection.url !== before) {
      try { response = await send(message, isInit); } catch { response = null; }
    }
    if (!response) return failAll(message, "Companion's vault bridge is not reachable at " + before + ". Open Obsidian with Companion's vault bridge turned on.");
  }
  if (response.status === 401) {
    // A new token: read the connection again and retry once.
    await response.text();
    const before = connection.token;
    let retried = null;
    if (readConnection() && connection.token !== before) retried = await send(message, isInit);
    if (!retried || retried.status === 401) {
      if (retried) await retried.text();
      return failAll(message, "Companion's vault bridge rejected the token. " + CONNECT_HINT);
    }
    response = retried;
  }
  const text = await response.text();
  if (response.status === 202 || response.status === 204) return;
  if (!response.ok) return failAll(message, "Companion's vault bridge answered HTTP " + response.status + ".");
  emit(text, response.headers.get("content-type") || "");
}
let ready = Promise.resolve();
const pending = new Set();
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  // The handshake (initialize, then notifications/initialized) completes in order before anything after it;
  // later requests run concurrently.
  const run = ready.then(() => forward(message));
  const method = !Array.isArray(message) && message ? message.method : undefined;
  if (method === "initialize" || method === "notifications/initialized") ready = run.catch(() => undefined);
  const task = run.catch((error) => failAll(message, String((error && error.message) || error)));
  pending.add(task);
  task.finally(() => pending.delete(task));
});
input.on("close", () => { Promise.allSettled([...pending]).then(() => process.exit(0)); });
`;

/** The MCPB manifest (spec 0.3) for the proxy. It has no settings: the connection file carries them. */
export function extensionManifest(version: string): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: EXTENSION_NAME,
    display_name: "Obsidian vault (Companion for Claude)",
    version,
    description: "Your Obsidian vault in Claude Desktop through Companion for Claude's vault bridge. Obsidian must be open.",
    author: { name: "Companion for Claude", url: "https://github.com/cavi-ai/companion-for-claude" },
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/server/index.js"] },
    },
    tools_generated: true,
    prompts_generated: true,
    compatibility: { platforms: ["darwin", "win32"], runtimes: { node: ">=18.0.0" } },
  };
}

/** The .mcpb bundle: a zip with manifest.json and server/index.js at its root. */
export function buildExtensionBundle(version: string, mtime = new Date("2026-01-01T00:00:00Z")): Uint8Array {
  return zipSync({
    "manifest.json": strToU8(`${JSON.stringify(extensionManifest(version), null, 2)}\n`),
    "server/index.js": strToU8(PROXY_SOURCE),
  }, { level: 6, mtime });
}

/**
 * claude_desktop_config.json without the `obsidian-vault` entry earlier Companion
 * versions wrote (npx mcp-remote to the loopback bridge, token in its args).
 * Null when there is no such entry or the file is not a JSON object: a config
 * Companion did not write is never touched.
 */
export function withoutLegacyBridgeEntry(source: string | null): string | null {
  if (!source?.trim()) return null;
  let root: unknown;
  try {
    root = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(root) || !isRecord(root.mcpServers)) return null;
  const entry = root.mcpServers["obsidian-vault"];
  if (!isRecord(entry) || entry.command !== "npx" || !Array.isArray(entry.args)) return null;
  const args = entry.args.filter((arg): arg is string => typeof arg === "string");
  if (!args.includes("mcp-remote") || !args.some((arg) => /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(arg))) return null;
  const { ["obsidian-vault"]: _removed, ...servers } = root.mcpServers;
  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}
