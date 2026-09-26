// Runs once before the whole `playwright test` invocation. Local iteration
// starts the rig by hand (`pnpm run e2e:rig start`) and reuses it across many
// runs; if none is running yet (e.g. CI), this starts one. Nothing ever stops
// it — the rig opens once and stays open (`e2e:rig stop` is a manual command
// nothing calls); CI's rig ends when the runner ends.

import { spawn } from "node:child_process";
import { DAEMON_PATH, PLUGIN_ROOT, liveState, readState, waitForHealth } from "./rig/client.ts";

export default async function globalSetup(): Promise<void> {
  const live = await liveState();
  if (live) return;

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
}
