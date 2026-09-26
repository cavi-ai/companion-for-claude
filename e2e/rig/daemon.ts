// The rig daemon: launches Obsidian exactly once, hosts the provider/endpoint/
// embed stubs and a loopback control API, and survives across `playwright
// test` invocations. Run via `pnpm run e2e:rig start` (e2e/rig/cli.ts spawns
// this file detached); never invoked directly by a test.

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { discoverCoreAsar } from "./coreAsarDiscovery.ts";
import { installFakeCli } from "./fakeCli.ts";
import { assertSupportedObsidian, connectRig, findObsidianPid, MANIFEST_PATH, settleObsidianPage, waitForCdp } from "./pageOps.ts";
import { seedVault } from "./seed.ts";
import { closeServer, freshStubState, startEmbedStub, startEndpointStub, startProviderStub } from "./stubs.ts";
import type { FailRule, ReplyRule, RigState, ScenarioOptions } from "./types.ts";
import { RIG_ROOT, STATE_PATH, liveState } from "./client.ts";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") { reject(new Error("No port")); return; } s.close(() => resolve(a.port)); });
  });
}

async function buildHash(): Promise<string> {
  const contents = await readFile(join(PLUGIN_ROOT, "main.js")).catch(() => Buffer.alloc(0));
  return createHash("sha1").update(contents).digest("hex").slice(0, 12);
}

async function isPidAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** `open -a` wants the .app bundle, not the Mach-O binary inside it. */
function bundlePath(executable: string): string {
  return executable.replace(/\/Contents\/MacOS\/Obsidian$/, "");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body ? JSON.parse(body) : {};
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function main(): Promise<void> {
  const existing = await liveState();
  if (existing) {
    console.error(`rig already running: pid ${existing.pid} (${existing.root})`);
    process.exit(1);
  }

  await rm(RIG_ROOT, { recursive: true, force: true }).catch(() => undefined);
  const vault = join(RIG_ROOT, "vault");
  const profile = join(RIG_ROOT, "profile");
  await mkdir(vault, { recursive: true });
  await mkdir(profile, { recursive: true });
  const { bin, argvLog } = await installFakeCli(RIG_ROOT);

  const provider = freshStubState();
  const endpoint = freshStubState();
  const [providerStub, endpointStub, embedStub] = await Promise.all([
    startProviderStub(provider),
    startEndpointStub(endpoint),
    startEmbedStub(),
  ]);
  const ports = { providerPort: providerStub.port, endpointPort: endpointStub.port, embedPort: embedStub.port };

  await seedVault(vault, ports, {}, PLUGIN_ROOT);
  await writeFile(join(profile, "obsidian.json"), JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }));

  const cdpPort = await freePort();
  const executable = process.env.OBSIDIAN_APP_PATH ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  const coreAsarPath = process.env.OBSIDIAN_ASAR_PATH?.trim() || await discoverCoreAsar();
  await assertSupportedObsidian(executable, MANIFEST_PATH, coreAsarPath);
  if (coreAsarPath) await copyFile(coreAsarPath, join(profile, coreAsarPath.split("/").pop()!));

  const hidden = process.env.CC_E2E_SHOW !== "1";
  const hiddenArgs = hidden ? ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--window-position=-4000,-4000"] : [];
  // Hermetic: only the rig's own fake CLIs and the OS's bare minimum are reachable —
  // no Homebrew, no nvm, no real claude/codex/opencode anywhere on this machine's PATH.
  // HOME is never overridden: a fake HOME pops macOS "Keychain Not Found" on the
  // operator's screen, so the real HOME flows through unmodified — `open` inherits
  // this daemon's own environment for the app it launches (see `man open`), we only
  // need to override SHELL/PATH explicitly.
  const hermeticPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const launchLog = join(RIG_ROOT, "obsidian-launch.log");
  await writeFile(launchLog, "");
  // `open -g -n` launches a fresh instance WITHOUT activating it — no Dock bounce,
  // no Space switch, no focus steal. A direct spawn of the binary activates the app
  // regardless of an off-screen --window-position, which is what stole the
  // operator's screen before. `open` never hands back the app's own pid (it asks
  // LaunchServices to spawn it), so it is recovered below via findObsidianPid.
  const opener = spawn("open", [
    "-g", "-n", "-a", bundlePath(executable),
    "--env", `SHELL=${join(bin, "login-shell")}`,
    "--env", `PATH=${hermeticPath}`,
    "--stdout", launchLog,
    "--stderr", launchLog,
    "--args", vault, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu", "--no-sandbox", ...hiddenArgs,
  ], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    opener.once("error", reject);
    opener.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`))));
  });
  let obsidianPid: number;
  try {
    obsidianPid = await findObsidianPid(profile);
    await waitForCdp(cdpPort);
  } catch (error) {
    const log = await readFile(launchLog, "utf8").catch(() => "");
    throw new Error(`${(error as Error).message}. ${log.slice(-1000)}`);
  }
  const connection = await connectRig(cdpPort);
  await settleObsidianPage(connection.context, connection.page, false, hidden, obsidianPid);

  const token = randomBytes(24).toString("hex");
  const controlPort = await freePort();

  const controlServer = createHttpServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) { sendJson(response, 401, { error: "unauthorized" }); return; }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      try {
        if (request.method === "GET" && url.pathname === "/health") { sendJson(response, 200, { ok: true }); return; }
        if (request.method === "GET" && url.pathname === "/ports") { sendJson(response, 200, ports); return; }
        if (request.method === "GET" && url.pathname === "/providerRequests") { sendJson(response, 200, { count: provider.requests }); return; }
        if (request.method === "POST" && url.pathname === "/stubs") {
          const body = await readJson(request) as ScenarioOptions;
          provider.requests = 0;
          provider.replyRules = (body.providerReply ?? []) as ReplyRule[];
          provider.failRules = (body.providerFail ?? []) as FailRule[];
          provider.delayMs = body.providerDelayMs ?? 0;
          endpoint.endpointModels = body.endpointModels ?? [];
          endpoint.endpointReply = body.endpointReply ?? "Answered locally by the endpoint stub.";
          sendJson(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && url.pathname === "/shutdown") {
          sendJson(response, 200, { ok: true });
          setTimeout(() => { void shutdown(); }, 50);
          return;
        }
        sendJson(response, 404, { error: "not found" });
      } catch (error) {
        sendJson(response, 500, { error: (error as Error).message });
      }
    })();
  });
  await new Promise<void>((resolve) => controlServer.listen(controlPort, "127.0.0.1", resolve));

  const state: RigState = {
    pid: process.pid,
    obsidianPid,
    cdpPort,
    controlPort,
    token,
    root: RIG_ROOT,
    vault,
    profile,
    argvLog,
    startedAt: new Date().toISOString(),
    pluginBuildHash: await buildHash(),
  };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`rig ready: obsidian pid ${obsidianPid}, control :${controlPort}, cdp :${cdpPort}`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(watchdog);
    await rm(STATE_PATH, { force: true }).catch(() => undefined);
    await closeServer(controlServer).catch(() => undefined);
    await closeServer(providerStub.server).catch(() => undefined);
    await closeServer(endpointStub.server).catch(() => undefined);
    await closeServer(embedStub.server).catch(() => undefined);
    if (await isPidAlive(obsidianPid)) {
      process.kill(obsidianPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (await isPidAlive(obsidianPid)) process.kill(obsidianPid, "SIGKILL");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  // `open` detached the real Obsidian process from us (it is not our child), so
  // there is no "exit" event to listen for — poll its liveness instead.
  const watchdog = setInterval(() => {
    void isPidAlive(obsidianPid).then((alive) => { if (!alive) void shutdown(); });
  }, 3_000);
}

void main();
