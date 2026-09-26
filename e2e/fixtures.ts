import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ControlClient, PLUGIN_ROOT, liveState } from "./rig/client.ts";
import { connectRig, cyclePlugin, openSettingsSurface, resetVaultState, setProcessEnv } from "./rig/pageOps.ts";
import type { ScenarioOptions, StubPorts } from "./rig/types.ts";

export interface Rig {
  page: Page;
  /** OS process identity of the one Obsidian instance every test shares. */
  processId: number;
  /** Where the fake claude logs its argv and stdin lines. */
  argvLog: string;
  paths: { vault: string; profile: string };
  control: ControlClient;
  windows(): Page[];
  openSettings(tabId?: string): Promise<Page>;
  providerRequests(): Promise<number>;
  /** Full scenario reset: stub rules, vault contents, plugin re-enable. Returns this rig for chaining. */
  reset(options?: ScenarioOptions): Promise<Rig>;
  /** Disable → enable the plugin in place, simulating "survives a restart" for anything persisted to data.json. */
  reloadPlugin(): Promise<void>;
  /** Mutate the renderer's live process.env over CDP (e.g. widen PATH for a liveClaude test). reset() restores the hermetic baseline. */
  setProcessEnv(env: Record<string, string>): Promise<void>;
  /** No-op: the rig is never torn down by a test. Kept so existing try/finally blocks port unchanged. */
  close(options?: { keep?: boolean }): Promise<void>;
}

async function buildRig(): Promise<Rig> {
  const state = await liveState();
  if (!state) throw new Error("no e2e rig is running — run `pnpm run e2e:rig start` first");
  const control = new ControlClient(state);
  const ports = await control.ports();
  const { context, page } = await connectRig(state.cdpPort);
  const bin = `${state.root}/bin`;
  // Mirrors the daemon's own launch env: HOME is never overridden (inherits the
  // real HOME), only PATH/SHELL stay hermetic. See rig/daemon.ts.
  const hermeticEnv: Record<string, string> = { SHELL: `${bin}/login-shell`, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  let lastTheme: "light" | "dark" = "light";

  const rig: Rig = {
    page,
    processId: state.obsidianPid,
    argvLog: state.argvLog,
    paths: { vault: state.vault, profile: state.profile },
    control,
    windows: () => context.pages().filter((candidate) => !candidate.isClosed()),
    openSettings: (tabId = "claude-companion") => openSettingsSurface(context, page, tabId),
    providerRequests: () => control.providerRequests(),
    async reset(options: ScenarioOptions = {}) {
      lastTheme = options.theme ?? "light";
      await control.setStubs(options);
      await resetVaultState({ context, page }, state.vault, state.argvLog, ports as StubPorts, PLUGIN_ROOT, options, hermeticEnv, state.obsidianPid);
      return rig;
    },
    async reloadPlugin() {
      await cyclePlugin(page, lastTheme);
    },
    async setProcessEnv(env: Record<string, string>) {
      await setProcessEnv(page, env);
    },
    async close() { /* the rig outlives every test; nothing to release */ },
  };
  return rig;
}

export const test = base.extend<{}, { rig: Rig }>({
  rig: [async ({}, use) => {
    const rig = await buildRig();
    await use(rig);
  }, { scope: "worker" }],
});

export { expect };
