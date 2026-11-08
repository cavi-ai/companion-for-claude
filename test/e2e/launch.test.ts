import { describe, expect, it, vi } from "vitest";
import { buildLaunchPlan } from "../../e2e/rig/launch";
import { connectRig } from "../../e2e/rig/pageOps";

const isolatedEnv = {
  CC_E2E_ISOLATED_LINUX: "1",
  CC_E2E_ROOT: "/tmp/companion-ui/e2e-rig",
  DISPLAY: ":99",
  OBSIDIAN_APP_PATH: "/opt/obsidian/obsidian",
  HOME: "/root",
  PATH: "/usr/local/bin:/personal/tools",
};

function plan(platform: string = "linux", env: Record<string, string | undefined> = isolatedEnv, containerized = true) {
  return buildLaunchPlan({ platform, env, containerized, root: "/tmp/companion-ui/e2e-rig", cdpPort: 45000 });
}

describe("isolated Obsidian launch", () => {
  it("refuses a CDP connection when explicit isolation is absent", async () => {
    vi.stubEnv("CC_E2E_ISOLATED_LINUX", "0");
    try {
      await expect(connectRig(0, "/tmp/companion-ui/e2e-rig/vault")).rejects.toThrow(/isolated Linux|CC_E2E_ISOLATED_LINUX/);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["darwin", "win32"])("refuses %s before launching an application", (platform) => {
    expect(() => plan(platform)).toThrow(/isolated Linux/);
  });

  it("refuses host Linux even with the marker and a local display", () => {
    expect(() => plan("linux", isolatedEnv, false)).toThrow(/container/);
  });

  it.each([undefined, "", "0"])("requires the explicit isolation marker %j", (marker) => {
    expect(() => plan("linux", { ...isolatedEnv, CC_E2E_ISOLATED_LINUX: marker })).toThrow(/CC_E2E_ISOLATED_LINUX/);
  });

  it.each([undefined, "", "host:0", "localhost:10"])("refuses an absent or remote display %j", (display) => {
    expect(() => plan("linux", { ...isolatedEnv, DISPLAY: display })).toThrow(/DISPLAY/);
  });

  it.each([undefined, "", "obsidian"])("requires an explicit absolute executable %j", (executable) => {
    expect(() => plan("linux", { ...isolatedEnv, OBSIDIAN_APP_PATH: executable })).toThrow(/OBSIDIAN_APP_PATH/);
  });

  it.each([undefined, "e2e-rig", "/tmp/another/e2e-rig"])("requires the dedicated rig root %j", (root) => {
    expect(() => plan("linux", { ...isolatedEnv, CC_E2E_ROOT: root })).toThrow(/CC_E2E_ROOT/);
  });

  it("launches the executable directly with only the owned vault and profile", () => {
    const launch = plan();
    expect(launch.command).toBe("/opt/obsidian/obsidian");
    expect(launch.args).toContain("/tmp/companion-ui/e2e-rig/vault");
    expect(launch.args).toContain("--user-data-dir=/tmp/companion-ui/e2e-rig/profile");
    expect(launch.args).toContain("--remote-debugging-port=45000");
    expect(launch.args).toContain("--no-sandbox");
    expect(launch.env.PATH).toBe("/tmp/companion-ui/e2e-rig/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(launch.env.SHELL).toBe("/tmp/companion-ui/e2e-rig/bin/login-shell");
    expect(launch.env.HOME).toBe("/root");
    expect(launch.env.DISPLAY).toBe(":99");
    expect(isolatedEnv.PATH).toBe("/usr/local/bin:/personal/tools");
  });
});
