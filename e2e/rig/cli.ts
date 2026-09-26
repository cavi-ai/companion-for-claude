// `pnpm run e2e:rig start|stop|status|reload` — the only sanctioned way to
// launch, refresh, or tear down the e2e rig's single Obsidian instance.

import { spawn } from "node:child_process";
import { installPluginBuild } from "./seed.ts";
import { connectRig, cyclePlugin } from "./pageOps.ts";
import { ControlClient, DAEMON_PATH, PLUGIN_ROOT, liveState, readState, waitForHealth } from "./client.ts";

async function start(): Promise<void> {
  const live = await liveState();
  if (live) {
    console.error(`rig already running: pid ${live.pid} (obsidian pid ${live.obsidianPid})`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [DAEMON_PATH], { cwd: PLUGIN_ROOT, detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 60_000;
  let state = await readState();
  while (!state && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    state = await readState();
  }
  if (!state) throw new Error("rig did not write state.json within 60s");
  await waitForHealth(state);
  console.log(`rig started: obsidian pid ${state.obsidianPid}, control :${state.controlPort}, cdp :${state.cdpPort}`);
}

async function stop(): Promise<void> {
  const live = await liveState();
  if (!live) { console.log("no rig running"); return; }
  const client = new ControlClient(live);
  await client.shutdown();
  const deadline = Date.now() + 10_000;
  while (await readState().then((s) => s !== null) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log("rig stopped");
}

async function status(): Promise<void> {
  const live = await liveState();
  if (!live) { console.log("no rig running"); return; }
  console.log(JSON.stringify({ obsidianPid: live.obsidianPid, cdpPort: live.cdpPort, controlPort: live.controlPort, startedAt: live.startedAt, pluginBuildHash: live.pluginBuildHash, vault: live.vault }, null, 2));
}

/** Copy the freshly built plugin into the live vault, then cycle it so the new code actually loads — no relaunch. */
async function reload(): Promise<void> {
  const live = await liveState();
  if (!live) { await start(); return; }
  await installPluginBuild(live.vault, PLUGIN_ROOT);
  const connection = await connectRig(live.cdpPort);
  await cyclePlugin(connection.page);
  console.log(`rig reloaded: obsidian pid ${live.obsidianPid}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "start": await start(); return;
    case "stop": await stop(); return;
    case "status": await status(); return;
    case "reload": await reload(); return;
    default:
      console.error("usage: e2e:rig start|stop|status|reload");
      process.exitCode = 1;
  }
}

// Exit once the command is done: the CDP connection `reload` opens would otherwise keep the process alive.
main().then(() => process.exit(process.exitCode ?? 0), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
