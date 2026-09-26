// HTTP client for the rig's control API, plus state.json plumbing. Shared by
// the CLI (start/stop/status/reload) and the Playwright `rig` fixture.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { RigState, ScenarioOptions } from "./types.ts";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One rig per machine: every checkout and worktree of the repo shares the main checkout's rig root. */
export function rigRootFor(gitCommonDir: string | null, pluginPathInRepo: string | null, pluginRoot: string): string {
  if (!gitCommonDir || pluginPathInRepo === null) return join(pluginRoot, ".tmp", "e2e-rig");
  return join(dirname(gitCommonDir), pluginPathInRepo, ".tmp", "e2e-rig");
}

function git(args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: PLUGIN_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

const toplevel = git(["rev-parse", "--show-toplevel"]);
export const RIG_ROOT = rigRootFor(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), toplevel ? relative(toplevel, PLUGIN_ROOT) : null, PLUGIN_ROOT);
export const STATE_PATH = join(RIG_ROOT, "state.json");

/** Roots of running rigs, read from each rig Obsidian main process's `--user-data-dir=<root>/profile`. */
export function rigRootsFromPs(ps: string): string[] {
  const roots = ps.split("\n").flatMap((line) => {
    if (line.includes("--type=")) return [];
    const match = /--user-data-dir=(\S+\/e2e-rig)\/profile(?:\s|$)/.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  return [...new Set(roots)];
}
export const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), "daemon.ts");

export async function readState(): Promise<RigState | null> {
  return readFile(STATE_PATH, "utf8").then((raw) => JSON.parse(raw) as RigState).catch(() => null);
}

export async function isPidAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A rig is "live" when a state.json names a running daemon: this machine's rig root first, then any rig Obsidian already running. */
export async function liveState(): Promise<RigState | null> {
  const own = await readState();
  if (own && await isPidAlive(own.pid)) return own;
  let ps = "";
  try { ps = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" }); } catch { return null; }
  for (const root of rigRootsFromPs(ps)) {
    const state = await readFile(join(root, "state.json"), "utf8").then((raw) => JSON.parse(raw) as RigState).catch(() => null);
    if (state && await isPidAlive(state.pid)) return state;
  }
  return null;
}

export class ControlClient {
  private readonly state: RigState;

  constructor(state: RigState) {
    this.state = state;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.state.controlPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.state.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`rig control ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  }

  health(): Promise<{ ok: boolean }> { return this.call("GET", "/health") as Promise<{ ok: boolean }>; }
  ports(): Promise<{ providerPort: number; endpointPort: number; embedPort: number }> { return this.call("GET", "/ports") as Promise<{ providerPort: number; endpointPort: number; embedPort: number }>; }
  providerRequests(): Promise<number> { return this.call("GET", "/providerRequests").then((r) => (r as { count: number }).count); }
  setStubs(scenario: ScenarioOptions): Promise<void> { return this.call("POST", "/stubs", scenario).then(() => undefined); }
  shutdown(): Promise<void> { return this.call("POST", "/shutdown").then(() => undefined); }
}

export async function waitForHealth(state: RigState, timeoutMs = 30_000): Promise<void> {
  const client = new ControlClient(state);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await client.health(); return; } catch { /* still starting */ }
    if (Date.now() > deadline) throw new Error("rig control API did not become healthy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
