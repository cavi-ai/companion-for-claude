import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";

/** The PATH macOS gives an app launched from the Dock or Finder. */
const GUI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

test("Codex and OpenCode installed on the login-shell PATH are found when Obsidian runs with the GUI PATH", async ({ rig }) => {
  // The Codex/OpenCode status rows are advanced-tier and hidden by default.
  const harness = await rig.reset({ settingsOverride: { settingsShowAdvanced: true } });
  try {
    const root = await mkdtemp(join(tmpdir(), "cc-cli-discovery-"));
    const bin = join(root, "shellbin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), `#!/bin/sh
case "$*" in
  *--version*) printf 'codex-cli 9.9.9\\n' ;;
  *"login status"*) printf 'Logged in using ChatGPT\\n' >&2 ;;
esac
`);
    await writeFile(join(bin, "opencode"), `#!/bin/sh
case "$*" in
  *--version*) printf '8.8.8\\n' ;;
  *"providers list"*) printf '2 credentials\\n' ;;
esac
`);
    await chmod(join(bin, "codex"), 0o755);
    await chmod(join(bin, "opencode"), 0o755);
    const shell = join(root, "login-shell");
    await writeFile(shell, `#!/bin/sh\nprintf 'motd\\n__CC_PATH__%s__CC_PATH__' "${bin}:/usr/bin:/bin"\n`);
    await chmod(shell, 0o755);

    // A GUI-launched app only gets /usr/bin:/bin:/usr/sbin:/sbin; the plugin
    // must fall back to the login shell's PATH to find Codex/OpenCode there.
    await rig.setProcessEnv({ PATH: GUI_PATH, SHELL: shell });
    // Force a fresh CLI runtime so the previous test's login-shell PATH lookup
    // isn't served from cache.
    await rig.reloadPlugin();

    const settingsPage = await harness.openSettings();
    const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
    // The `has` locator must be page-relative, not re-prefixed with `tab`'s own
    // ancestor chain, or it never matches inside each candidate's subtree.
    const codexRow = tab.locator(".setting-item").filter({ has: settingsPage.getByRole("button", { name: "Check Codex", exact: true }) });
    const opencodeRow = tab.locator(".setting-item").filter({ has: settingsPage.getByRole("button", { name: "Check OpenCode", exact: true }) });

    await codexRow.getByRole("button", { name: "Check Codex", exact: true }).click();
    await opencodeRow.getByRole("button", { name: "Check OpenCode", exact: true }).click();

    await expect(codexRow.locator(".cc-conn-status")).toContainText("Codex 9.9.9 · signed in via ChatGPT", { timeout: 10_000 });
    await expect(opencodeRow.locator(".cc-conn-status")).toContainText("OpenCode 8.8.8 · signed in via 2 credentials", { timeout: 10_000 });
  } finally {
    await harness.close();
  }
});
