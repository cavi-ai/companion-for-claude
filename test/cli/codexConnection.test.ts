import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeCliRuntime } from "../../src/cli/runtime";
import { codexBackend } from "../../src/cli/backends/codex";
import { CliProvider } from "../../src/providers/cliProvider";

const nodeRequire = createRequire(import.meta.url);
let root: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(process.platform === "win32")("Codex connection through the desktop runtime", () => {
  async function provider(signedIn: boolean): Promise<CliProvider> {
    root = await mkdtemp(join(tmpdir(), "companion-codex-connect-"));
    const shell = join(root, "login-shell");
    await writeFile(shell, `#!/bin/sh\nprintf '__CC_PATH__%s__CC_PATH__' '${root}:/usr/bin:/bin'\n`, { mode: 0o700 });
    await writeFile(join(root, "codex"), `#!/bin/sh
case "$*" in
  --version) printf 'codex-cli 0.162.1\\n' ;;
  'login status') printf '${signedIn ? "Logged in using ChatGPT" : "Not logged in"}\\n' >&2; exit ${signedIn ? 0 : 1} ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    // Keep real child processes and the provider; replace only Electron's environment boundary.
    vi.stubGlobal("window", { require: (name: string) => name === "node:process"
      ? { platform: process.platform, env: { PATH: "/usr/bin:/bin", SHELL: shell } }
      : nodeRequire(name) });
    return new CliProvider(codexBackend, createNodeCliRuntime());
  }

  it("connects a signed-in Codex found only on the login shell PATH, with status on stderr", async () => {
    const cli = await provider(true);
    expect((await cli.test()).ok).toBe(true);
    expect(cli.hasCredentials()).toBe(true);
    expect(cli.executable()).toBe("codex");
    expect(cli.probe()).toMatchObject({ version: "0.162.1", loggedIn: true, method: "ChatGPT" });
  });

  it("keeps a genuinely signed-out Codex disconnected", async () => {
    const cli = await provider(false);
    expect((await cli.test()).ok).toBe(false);
    expect(cli.hasCredentials()).toBe(false);
    expect(cli.executable()).toBeNull();
  });
});
