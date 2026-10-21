// The Claude Desktop extension (.mcpb) for Companion's vault bridge: a manifest
// plus a dependency-free stdio proxy that Claude Desktop runs on its built-in
// Node. The proxy reads the bridge address and token from a user-only
// connection file Companion writes outside the vault, so installing asks for
// nothing and a changed token or port is picked up without reinstalling. It
// answers the MCP handshake itself, so Claude Desktop keeps it connected while
// Obsidian is closed, and opens Obsidian when a vault tool is called. Pure.

import { strToU8, zipSync } from "fflate";
import { REPOSITORY_URL } from "../project";
import { isRecord } from "../records";
import type { DesktopPlatform } from "./desktop";

/** Bundle file name; no spaces so every platform's opener takes it as one argument. */
export const EXTENSION_FILE_NAME = "companion-obsidian-vault.mcpb";
export const EXTENSION_NAME = "companion-obsidian-vault";
/** Version of the proxy and manifest; raise it when either changes so Claude Desktop offers the update. */
export const EXTENSION_VERSION = "1.2.0";
/** Folder of the connection file, under the platform's per-user application data. */
const CONNECTION_FOLDER = "Companion for Claude";
const CONNECTION_FILE = "bridge.json";
/** The last tool list the bridge served, kept beside the connection file for starts while Obsidian is closed. */
const TOOLS_FILE = "tools.json";

/** The vault a connection file belongs to: its name opens it, its path identifies it. */
export interface ConnectionVault {
  name: string;
  path: string;
}

/** Where Companion writes the connection file the extension reads; the proxy derives the same path. */
export function connectionFilePath(platform: DesktopPlatform, homeDir: string, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.replace(/[\\/]+$/, "") || `${homeDir}\\AppData\\Roaming`;
    return `${appData}\\${CONNECTION_FOLDER}\\${CONNECTION_FILE}`;
  }
  return `${homeDir.replace(/\/+$/, "")}/Library/Application Support/${CONNECTION_FOLDER}/${CONNECTION_FILE}`;
}

/** The connection file's body: the bridge's MCP endpoint, its bearer token, and the vault that serves it. */
export function connectionFileBody(url: string, token: string, vault?: ConnectionVault): string {
  const body = vault ? { url, token, vault: vault.name, vaultPath: vault.path } : { url, token };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The connection file brought up to date with this vault's running bridge, or
 * null when it needs no write: it is missing or unreadable, belongs to another
 * vault (or to none, written before files named their vault), or already holds
 * this address and token. Only Connect Claude Desktop claims a file for a vault.
 */
export function refreshedConnectionBody(source: string | null, url: string, token: string, vault: ConnectionVault): string | null {
  if (!source?.trim()) return null;
  let current: unknown;
  try {
    current = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(current) || current.vaultPath !== vault.path) return null;
  if (current.url === url && current.token === token && current.vault === vault.name) return null;
  return connectionFileBody(url, token, vault);
}

/** MCP over stdio to Companion's loopback HTTP bridge. Runs under plain `node`; uses only built-ins. */
export const PROXY_SOURCE = String.raw`"use strict";
// Companion for Claude: MCP over stdio to Companion's vault bridge in Obsidian. The handshake is answered here, so the
// server stays connected while Obsidian is closed; calling a vault tool opens Obsidian and waits for its bridge.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const FOLDER = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "${CONNECTION_FOLDER}")
  : path.join(os.homedir(), "Library", "Application Support", "${CONNECTION_FOLDER}");
const CONNECTION_FILE = path.join(FOLDER, "${CONNECTION_FILE}");
const TOOLS_FILE = path.join(FOLDER, "${TOOLS_FILE}");
const SERVER_INFO = { name: "obsidian-vault", version: "${EXTENSION_VERSION}" };
const CONNECT_HINT = "In Obsidian, open Companion's Desktop integrations and click Connect Claude Desktop.";
const LAUNCH_WAIT_MS = 30000;
const RETRY_MS = 500;
class Unavailable extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}
let connection = null;
let ready = false;
let session = null;
let opening = null;
let launching = null;
let servedFromCache = false;
let clientInit = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-desktop", version: "0" } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
function readConnection() {
  const value = readJson(CONNECTION_FILE);
  const next = value && typeof value.url === "string" && typeof value.token === "string" && value.url && value.token ? value : null;
  if (!next || !connection || next.url !== connection.url || next.token !== connection.token) { ready = false; session = null; }
  connection = next;
  return connection;
}
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, message) => out({ jsonrpc: "2.0", id, error: { code: -32000, message } });
function saveTools(tools) {
  try {
    fs.mkdirSync(FOLDER, { recursive: true });
    const temporary = TOOLS_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(tools), { mode: 0o600 });
    fs.renameSync(temporary, TOOLS_FILE);
  } catch { /* the list is only kept for starts while Obsidian is closed */ }
}
async function post(message) {
  if (!connection && !readConnection()) throw new Unavailable("Companion's connection file is missing. " + CONNECT_HINT, "missing");
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + connection.token };
  if (session) headers["mcp-session-id"] = session;
  let response;
  try {
    response = await fetch(connection.url, { method: "POST", headers, body: JSON.stringify(message) });
  } catch {
    throw new Unavailable("Obsidian is closed or Companion's vault bridge is off (" + connection.url + "). Open Obsidian with Companion's vault bridge turned on.", "closed");
  }
  if (response.status === 401) {
    await response.text();
    throw new Unavailable("Companion's vault bridge rejected the token. " + CONNECT_HINT, "token");
  }
  const id = response.headers.get("mcp-session-id");
  if (id) session = id;
  return response;
}
async function messagesOf(response) {
  const text = await response.text();
  const bodies = (response.headers.get("content-type") || "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  const messages = [];
  for (const body of bodies) {
    if (!body.trim()) continue;
    try { messages.push(JSON.parse(body)); } catch { /* not JSON-RPC */ }
  }
  return messages;
}
async function openSession() {
  session = null;
  const response = await post({ jsonrpc: "2.0", id: "companion-init", method: "initialize", params: clientInit });
  await response.text();
  if (!response.ok) throw new Unavailable("Companion's vault bridge answered HTTP " + response.status + ".", "http");
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
  ready = true;
  // The client was given the saved tool list; have it ask the running bridge again.
  if (servedFromCache) { servedFromCache = false; out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
}
function ensureSession() {
  if (ready) return Promise.resolve();
  opening = opening || openSession().finally(() => { opening = null; });
  return opening;
}
async function request(message) {
  await ensureSession();
  let response = await post(message);
  // The bridge forgets sessions when Obsidian restarts; open a new one and retry once.
  if (response.status === 404) {
    await response.text();
    ready = false;
    await ensureSession();
    response = await post(message);
  }
  if (!response.ok) {
    await response.text();
    throw new Unavailable("Companion's vault bridge answered HTTP " + response.status + ".", "http");
  }
  const messages = await messagesOf(response);
  const answer = messages.find((m) => m && m.id === message.id);
  if (!answer) throw new Unavailable("Companion's vault bridge sent no answer.", "http");
  return answer;
}
async function attempt(message) {
  try {
    return await request(message);
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    // The port or token may have changed since the connection file was read.
    const before = connection ? connection.url + " " + connection.token : null;
    readConnection();
    if (!connection || connection.url + " " + connection.token === before) throw error;
    return request(message);
  }
}
function launchObsidian() {
  const vault = connection && typeof connection.vault === "string" ? connection.vault : "";
  const uri = "obsidian://open" + (vault ? "?vault=" + encodeURIComponent(vault) : "");
  return new Promise((resolve) => {
    let child;
    try {
      child = process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "start \"\" \"" + uri + "\""], { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
        : spawn("open", ["-g", uri], { stdio: "ignore" });
    } catch { resolve(false); return; }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
async function reachBridge(message) {
  try {
    return await attempt(message);
  } catch (error) {
    if (!(error instanceof Unavailable) || error.reason !== "closed") throw error;
    launching = launching || launchObsidian().finally(() => { launching = null; });
    if (!(await launching)) throw new Unavailable("Obsidian could not be opened. Open Obsidian with Companion's vault bridge turned on.", "closed");
    const deadline = Date.now() + LAUNCH_WAIT_MS;
    let last = error;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      readConnection();
      try { return await request(message); } catch (next) {
        if (!(next instanceof Unavailable)) throw next;
        last = next;
      }
    }
    throw last;
  }
}
const EMPTY = { "prompts/list": { prompts: [] }, "resources/list": { resources: [] }, "resources/templates/list": { resourceTemplates: [] } };
async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method } = message;
  if (id === undefined || id === null) return; // client notifications concern the handshake answered here
  if (method === "initialize") {
    const params = message.params || {};
    clientInit = {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : clientInit.protocolVersion,
      capabilities: {},
      clientInfo: params.clientInfo || clientInit.clientInfo,
    };
    return reply(id, {
      protocolVersion: clientInit.protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    try {
      const answer = await attempt(message);
      if (answer.result && Array.isArray(answer.result.tools)) saveTools(answer.result.tools);
      return out(answer);
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      const saved = readJson(TOOLS_FILE);
      servedFromCache = true;
      return reply(id, { tools: Array.isArray(saved) ? saved : [] });
    }
  }
  if (method === "tools/call") {
    try {
      return out(await reachBridge(message));
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      return reply(id, { content: [{ type: "text", text: error.message }], isError: true });
    }
  }
  try {
    return out(await attempt(message));
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    return EMPTY[method] ? reply(id, EMPTY[method]) : fail(id, error.message);
  }
}
const pending = new Set();
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    const task = handle(message).catch((error) => {
      if (message && message.id !== undefined && message.id !== null) fail(message.id, String((error && error.message) || error));
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
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
    description: "Your Obsidian vault in Claude Desktop through Companion for Claude's vault bridge. Calling a vault tool opens Obsidian when it is closed.",
    author: { name: "Companion for Claude", url: REPOSITORY_URL },
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
