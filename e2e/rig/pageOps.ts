// CDP-driven page automation shared by the daemon (initial settle), the CLI's
// `reload` command, and the Playwright fixture (per-test reset). Each caller
// makes its own chromium.connectOverCDP() to the same live Obsidian instance;
// none of them ever call browser.close() — that would terminate the real app.

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareVersions, effectiveObsidianCoreVersion } from "../coreAsar.ts";
import { seedVault } from "./seed.ts";
import type { ScenarioOptions, StubPorts } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function waitForCdp(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return; } catch { /* app still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Obsidian did not expose its debugging endpoint");
}

export interface RigConnection { browser: Browser; context: BrowserContext; page: Page }

/**
 * `open -a` never hands back the launched app's pid (LaunchServices spawns it,
 * not us), so find the real Electron main process by the --user-data-dir it was
 * launched with. Excludes Chromium's own renderer/GPU/utility helper processes,
 * which all carry a --type= flag that the main process never does.
 */
export async function findObsidianPid(userDataDir: string, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) continue;
      const command = trimmed.slice(spaceIndex + 1);
      if (command.includes(`--user-data-dir=${userDataDir}`) && !command.includes("--type=")) {
        return Number(trimmed.slice(0, spaceIndex));
      }
    }
    if (Date.now() > deadline) throw new Error(`Obsidian process with --user-data-dir=${userDataDir} did not appear`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Connect to the running Obsidian instance and find its vault window. Never disconnects the app — just drop the reference when done. */
export async function connectRig(cdpPort: number): Promise<RigConnection> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Obsidian browser context not found");
  let page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md"));
  const deadline = Date.now() + 30_000;
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md"));
  }
  if (!page) throw new Error("Obsidian page not found");
  return { browser, context, page };
}

/** The plugin only loads on Obsidian >= manifest.minAppVersion; check up front and say what to do about it. */
export async function assertSupportedObsidian(executable: string, manifestPath: string, coreAsarPath?: string): Promise<void> {
  const plist = executable.replace(/\/MacOS\/Obsidian$/, "/Info.plist");
  const { minAppVersion } = JSON.parse(await readFile(manifestPath, "utf8")) as { minAppVersion: string };
  let installed: string;
  try {
    const raw = await readFile(plist, "utf8");
    installed = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(raw)?.[1] ?? "";
  } catch {
    return; // Not a macOS bundle — leave the launch to report what went wrong.
  }
  if (!installed) return;
  const effective = effectiveObsidianCoreVersion(installed, coreAsarPath);
  if (compareVersions(effective, minAppVersion) < 0) {
    throw new Error(
      `Obsidian core ${effective} is available but this plugin requires ${minAppVersion} or later. `
        + `Update Obsidian, point OBSIDIAN_APP_PATH at a ${minAppVersion}+ build, or set OBSIDIAN_ASAR_PATH to an official ${minAppVersion}+ core ASAR.`,
    );
  }
}

let hideWarned = false;
/** Deactivate the Obsidian process without a real OS-level hide (that pauses the Chromium renderer and blanks screenshots); a failure is logged once and the run stays visible. */
export async function hideAppWindow(pid: number): Promise<void> {
  try {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to false`]);
  } catch (error) {
    if (!hideWarned) { hideWarned = true; console.warn("rig: could not unfocus the Obsidian window, run stays visible:", error); }
  }
}

/** The container Obsidian renders a settings tab into, whichever window holds it. */
const SETTINGS_TAB = ".vertical-tab-content-container .vertical-tab-content";

/** Ask Obsidian to open `tabId`, then resolve the window that actually rendered it — Settings is a separate BrowserWindow on 1.13+. */
export async function openSettingsSurface(context: BrowserContext, page: Page, tabId: string): Promise<Page> {
  await page.evaluate((id) => {
    const app = (window as unknown as { app: { setting: { open(): void; openTabById(id: string): void } } }).app;
    app.setting.open();
    app.setting.openTabById(id);
  }, tabId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      const rendered = await candidate.locator(SETTINGS_TAB).count().catch(() => 0);
      if (rendered > 0) return candidate;
    }
    if (Date.now() > deadline) throw new Error(`Settings tab ${tabId} did not render in any Obsidian window`);
    await page.waitForTimeout(150);
  }
}

export async function settleObsidianPage(context: BrowserContext, page: Page, firstRun: boolean, hidden: boolean, pid?: number, checkTrust = true): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { app?: unknown }).app));
  if (hidden && pid) await hideAppWindow(pid);
  if (checkTrust) {
    const trustDeadline = Date.now() + 5_000;
    let trustAccepted = false;
    while (!trustAccepted && Date.now() < trustDeadline) {
      for (const candidate of context.pages()) {
        const trustButton = candidate.getByRole("button", { name: "Trust author and enable plugins" });
        if (await trustButton.isVisible().catch(() => false)) {
          await trustButton.click();
          trustAccepted = true;
          break;
        }
      }
      if (!trustAccepted) await page.waitForTimeout(100);
    }
  }
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { commands?: { commands?: Record<string, unknown> } } }).app;
    return Boolean(app?.commands?.commands?.["claude-companion:open-research-desk"]);
  }, undefined, { timeout: 30_000 });

  const setupDeadline = Date.now() + (firstRun ? 0 : 8_000);
  let quietSince = Date.now();
  while (Date.now() < setupDeadline && Date.now() - quietSince < 1_500) {
    const deferSetup = page.getByRole("button", { name: "Not now" }).last();
    const appeared = await deferSetup.waitFor({ state: "visible", timeout: 250 }).then(() => true).catch(() => false);
    if (!appeared) continue;
    await deferSetup.click();
    quietSince = Date.now();
  }

  if (!firstRun) {
    for (const candidate of context.pages()) {
      if (candidate === page || candidate.isClosed()) continue;
      const title = await candidate.title().catch(() => "");
      if (title.startsWith("Settings - ")) await candidate.close();
    }
    await page.bringToFront();
    if (hidden && pid) await hideAppWindow(pid);
  }
}

/** Resize the right sidebar (where the chat pane docks) to `px` for narrow-pane layout tests. */
export async function setRightSidebarWidth(page: Page, px: number): Promise<void> {
  await page.evaluate((size) => {
    const w = window as unknown as {
      app: { workspace: { rightSplit: { setSize?(px: number): void; containerEl: HTMLElement }; onLayoutChange(): void } };
    };
    const rightSplit = w.app.workspace.rightSplit;
    if (typeof rightSplit.setSize === "function") rightSplit.setSize(size);
    rightSplit.containerEl.style.width = `${size}px`;
    rightSplit.containerEl.style.minWidth = `${size}px`;
    rightSplit.containerEl.style.maxWidth = `${size}px`;
    rightSplit.containerEl.style.flex = `0 0 ${size}px`;
    rightSplit.containerEl.style.flexBasis = `${size}px`;
    w.app.workspace.onLayoutChange();
  }, px);
  await page.waitForFunction(
    (expectedWidth) => {
      const split = document.querySelector<HTMLElement>(".workspace-split.mod-right-split");
      const width = split?.getBoundingClientRect().width;
      return typeof width === "number" && Math.abs(width - expectedWidth) <= 0.5;
    },
    px,
    { timeout: 5_000 },
  );
}

/** Disable then re-enable the plugin in place — simulates "survives a restart" for everything the plugin persists to data.json, without relaunching Obsidian. */
export async function cyclePlugin(page: Page, theme: "light" | "dark" = "light"): Promise<void> {
  await page.evaluate(async (nextTheme) => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(nextTheme === "dark" ? "theme-dark" : "theme-light");
    const app = (window as unknown as { app: { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } } }).app;
    await app.plugins.disablePlugin("claude-companion");
    await app.plugins.enablePlugin("claude-companion");
  }, theme);
}

/** Merge `env` into the renderer's live process.env over CDP — the CLI runtime reads process.env at call time, so this exercises the real product code path. */
export async function setProcessEnv(page: Page, env: Record<string, string>): Promise<void> {
  await page.evaluate((vars) => {
    const proc = (window as unknown as { process?: { env?: Record<string, string> } }).process;
    if (!proc?.env) throw new Error("renderer process.env is not available");
    Object.assign(proc.env, vars);
  }, env);
}

// Mirrors src/secrets/store.ts's SECRET_IDS. Obsidian's secretStorage is scoped
// to the profile dir, not the vault, so it survives a vault wipe: the plugin's
// own hydrate() repopulates any settings field the store still holds a value
// for, regardless of what a freshly reseeded data.json says. The fixed rig
// profile makes that a real cross-scenario leak unless reset resyncs it too —
// but wiping it outright is just as wrong, since the store is the only place a
// credential still lives once the product's own persist cycle strips it from
// data.json (proven live: seeding apiKey then blanking the store here reads
// back as "No Anthropic credential set").
const SECRET_FIELD_IDS: Record<string, string> = {
  apiKey: "claude-companion-api-key",
  oauthToken: "claude-companion-oauth-token",
  openaiCompatKey: "claude-companion-openai-compat-key",
  zoteroApiKey: "claude-companion-zotero-key",
  braveSearchApiKey: "claude-companion-brave-key",
  mcpToken: "claude-companion-mcp-token",
  cloudRoutineToken: "claude-companion-cloud-routine-token",
  cloudReplyToken: "claude-companion-cloud-reply-token",
};

/** Make the secret store exactly match this scenario's freshly seeded settings — never more, never less. */
export async function syncSecretStore(page: Page, settings: Record<string, unknown>): Promise<void> {
  const values: Record<string, string> = {};
  for (const [field, id] of Object.entries(SECRET_FIELD_IDS)) {
    const value = settings[field];
    values[id] = typeof value === "string" ? value : "";
  }
  await page.evaluate((entries) => {
    const store = (window as unknown as { app: { secretStorage?: { setSecret(id: string, value: string): void } } }).app.secretStorage;
    if (!store) return;
    for (const [id, value] of entries) {
      try { store.setSecret(id, value); } catch { /* backend unavailable on this platform */ }
    }
  }, Object.entries(values));
}

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "manifest.json");

/**
 * Full per-scenario reset: close extra windows/modals, detach every Companion
 * leaf, disable the plugin, wipe the vault except `.obsidian`, reseed fixture
 * notes + data.json, clear the argv log, restore env, re-enable, settle.
 */
export async function resetVaultState(
  connection: Pick<RigConnection, "context" | "page">,
  vault: string,
  argvLog: string,
  ports: StubPorts,
  buildDir: string,
  options: ScenarioOptions,
  originalEnv: Record<string, string>,
  processId: number,
): Promise<void> {
  const { context, page } = connection;
  for (const candidate of context.pages()) {
    if (candidate !== page && !candidate.isClosed()) await candidate.close();
  }
  for (let attempt = 0; attempt < 6 && await page.locator(".modal-container").count(); attempt += 1) {
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => {
    const app = (window as unknown as {
      app: { plugins: { disablePlugin(id: string): Promise<void> }; workspace: { getLeavesOfType(type: string): Array<{ detach(): void }> } };
    }).app;
    for (const type of ["claude-companion-chat", "claude-research-desk", "claude-research-workbench", "claude-build-runner", "claude-source-inbox", "markdown"]) {
      for (const leaf of app.workspace.getLeavesOfType(type)) leaf.detach();
    }
    return app.plugins.disablePlugin("claude-companion");
  });
  for (const entry of await readdir(vault)) {
    if (entry !== ".obsidian") await rm(join(vault, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  await rm(join(vault, ".obsidian", "plugins", "claude-companion"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const file of ["appearance.json", "workspace.json", "workspace-mobile.json"]) {
    await rm(join(vault, ".obsidian", file), { force: true });
  }
  await seedVault(vault, ports, options, buildDir);
  const dataPath = join(vault, ".obsidian", "plugins", "claude-companion", "data.json");
  const data = JSON.parse(await readFile(dataPath, "utf8")) as { settings?: Record<string, unknown> };
  // The store, not the file, is where a credential survives across resets —
  // make it exactly match this scenario before the plugin's hydrate() runs.
  await syncSecretStore(page, data.settings ?? {});
  if (data.settings) delete data.settings.apiKey;
  await writeFile(dataPath, JSON.stringify(data));
  await writeFile(argvLog, "");

  // Restore the hermetic env (a liveClaude test may have widened PATH) before the next scenario.
  await setProcessEnv(page, originalEnv);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(async (theme) => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(theme === "dark" ? "theme-dark" : "theme-light");
    const app = (window as unknown as { app: { plugins: { enablePlugin(id: string): Promise<void> } } }).app;
    await app.plugins.enablePlugin("claude-companion");
  }, options.theme ?? "light");
  await settleObsidianPage(context, page, options.firstRun === true, options.hidden ?? process.env.CC_E2E_SHOW !== "1", processId, false);
  await page.evaluate(() => {
    document.querySelectorAll(".notice").forEach((notice) => notice.remove());
    // Belt-and-suspenders: the "Claude finished" status-bar item (main.ts
    // showTurnCompleteStatusBar) is expected to self-clean on plugin unload,
    // but a reset must never let a prior scenario's element read as this one's.
    document.querySelectorAll(".cc-turn-complete-status").forEach((el) => el.remove());
    document.body.classList.remove("is-mobile");
    const rightSplit = document.querySelector<HTMLElement>(".workspace-split.mod-right-split");
    for (const property of ["display", "position", "inset", "width", "min-width", "max-width", "flex", "z-index"]) {
      rightSplit?.style.removeProperty(property);
    }
    const workspace = (window as unknown as {
      app: { workspace: { leftSplit: { setSize?(px: number): void }; rightSplit: { setSize?(px: number): void }; onLayoutChange(): void } };
    }).app.workspace;
    workspace.leftSplit.setSize?.(300);
    workspace.rightSplit.setSize?.(520);
    workspace.onLayoutChange();
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
}

export { MANIFEST_PATH };
