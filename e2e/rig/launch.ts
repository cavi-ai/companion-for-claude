import { isAbsolute, join } from "node:path";

export interface LaunchOptions {
  platform: string;
  containerized: boolean;
  env: Record<string, string | undefined>;
  root: string;
  cdpPort: number;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** Only an explicitly isolated Linux display may host an automated app. */
export function buildLaunchPlan({ platform, containerized, env, root, cdpPort }: LaunchOptions): LaunchPlan {
  if (platform !== "linux") throw new Error("The e2e rig requires isolated Linux; host desktop automation is refused.");
  if (!containerized) throw new Error("The e2e rig requires an isolated Linux container; host Linux is refused.");
  if (env.CC_E2E_ISOLATED_LINUX !== "1") throw new Error("Set CC_E2E_ISOLATED_LINUX=1 only inside an isolated Linux runner.");
  if (!/^:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? "")) throw new Error("DISPLAY must name the isolated runner's local X display.");
  const command = env.OBSIDIAN_APP_PATH;
  if (!command || !isAbsolute(command)) throw new Error("OBSIDIAN_APP_PATH must name the isolated runner's absolute Obsidian executable.");
  if (!env.CC_E2E_ROOT || !isAbsolute(env.CC_E2E_ROOT) || env.CC_E2E_ROOT !== root) throw new Error("CC_E2E_ROOT must explicitly select the dedicated absolute rig root.");
  const bin = join(root, "bin");
  return {
    command,
    args: [
      join(root, "vault"), `--user-data-dir=${join(root, "profile")}`, `--remote-debugging-port=${cdpPort}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    ],
    // The runner owns its HOME; inherit it without substituting a user's home.
    // Only the fixture CLIs and minimal OS tools are reachable by the app.
    env: { ...env, SHELL: join(bin, "login-shell"), PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
  };
}
