import { prepareRigRoot } from "./ownership.ts";
// The rig daemon: launches Obsidian exactly once, hosts the provider/endpoint/
// embed stubs and a loopback control API, and survives across `playwright
// test` invocations. Run via `pnpm run e2e:rig start` (e2e/rig/cli.ts spawns
// this file detached); never invoked directly by a test.

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, open, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildLaunchPlan } from "./launch.ts";
import { installFakeCli } from "./fakeCli.ts";
import { assertSupportedObsidian, connectRig, MANIFEST_PATH, settleObsidianPage, waitForCdp } from "./pageOps.ts";
import { seedVault } from "./seed.ts";
import { closeServer, freshGithubState, freshStubState, startEmbedStub, startEndpointStub, startGithubStub, startProviderStub } from "./stubs.ts";
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
  // Validate before seeding files or starting any app. There is no host desktop route.
  const cdpPort = await freePort();
  const launch = buildLaunchPlan({ platform: process.platform, containerized: existsSync("/.dockerenv"), env: process.env, root: RIG_ROOT, cdpPort });
  await access(launch.command, constants.X_OK);
  const existing = await liveState();
  if (existing) {
    console.error(`rig already running: pid ${existing.pid} (${existing.root})`);
    process.exit(1);
  }

  await prepareRigRoot(RIG_ROOT);
  const vault = join(RIG_ROOT, "vault");
  const profile = join(RIG_ROOT, "profile");
  await mkdir(vault, { recursive: true });
  await mkdir(profile, { recursive: true });
  const { argvLog } = await installFakeCli(RIG_ROOT);

  const cleanupTasks: Array<() => Promise<void>> = [];
  const cleanup = async (): Promise<void> => {
    for (const task of [...cleanupTasks].reverse()) await task().catch(() => undefined);
  };
  try {
    const provider = freshStubState();
    const endpoint = freshStubState();
    const github = freshGithubState();
    const providerStub = await startProviderStub(provider);
    cleanupTasks.push(() => closeServer(providerStub.server));
    const endpointStub = await startEndpointStub(endpoint);
    cleanupTasks.push(() => closeServer(endpointStub.server));
    const embedStub = await startEmbedStub();
    cleanupTasks.push(() => closeServer(embedStub.server));
    const githubStub = await startGithubStub(github);
    cleanupTasks.push(() => closeServer(githubStub.server));
    const ports = { providerPort: providerStub.port, endpointPort: endpointStub.port, embedPort: embedStub.port, githubPort: githubStub.port };

    await seedVault(vault, ports, {}, PLUGIN_ROOT);
    await writeFile(join(profile, "obsidian.json"), JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }));

    const coreAsarPath = process.env.OBSIDIAN_ASAR_PATH?.trim();
    await assertSupportedObsidian(launch.command, MANIFEST_PATH, coreAsarPath);
    if (coreAsarPath) await copyFile(coreAsarPath, join(profile, coreAsarPath.split("/").pop()!));

    const launchLog = join(RIG_ROOT, "obsidian-launch.log");
    const logFile = await open(launchLog, "w");
    const app = spawn(launch.command, launch.args, { env: launch.env, stdio: ["ignore", logFile.fd, logFile.fd] });
    cleanupTasks.push(async () => {
      if (!app.pid || !await isPidAlive(app.pid)) return;
      app.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (await isPidAlive(app.pid)) app.kill("SIGKILL");
    });
    try {
      await new Promise<void>((resolve, reject) => { app.once("spawn", resolve); app.once("error", reject); });
    } finally { await logFile.close(); }
    const obsidianPid = app.pid!;
    try {
      await waitForCdp(cdpPort);
    } catch (error) {
      const log = await readFile(launchLog, "utf8").catch(() => "");
      throw new Error(`${(error as Error).message}. ${log.slice(-1000)}`);
    }
    const connection = await connectRig(cdpPort, vault);
    await settleObsidianPage(connection.context, connection.page, false, true, obsidianPid);

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
          if (request.method === "GET" && url.pathname === "/providerServed") { sendJson(response, 200, { count: provider.served }); return; }
          if (request.method === "GET" && url.pathname === "/githubRequests") { sendJson(response, 200, { requests: github.requests }); return; }
          if (request.method === "POST" && url.pathname === "/stubs") {
            const body = await readJson(request) as ScenarioOptions;
            provider.requests = 0;
            provider.served = 0;
            github.requests = [];
            github.created = 0;
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
    cleanupTasks.push(() => closeServer(controlServer));
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
    cleanupTasks.push(() => rm(STATE_PATH, { force: true }));
    console.log(`rig ready: obsidian pid ${obsidianPid}, control :${controlPort}, cdp :${cdpPort}`);

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(watchdog);
      await cleanup();
      process.exit(0);
    };
    process.on("SIGTERM", () => { void shutdown(); });
    process.on("SIGINT", () => { void shutdown(); });
    // Shut down the owned services if the isolated app exits unexpectedly.
    const watchdog = setInterval(() => {
      void isPidAlive(obsidianPid).then((alive) => { if (!alive) void shutdown(); });
    }, 3_000);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
