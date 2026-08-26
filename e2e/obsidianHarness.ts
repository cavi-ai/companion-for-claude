import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { compareVersions, effectiveObsidianCoreVersion, newestCoreAsar } from "./coreAsar";

export { effectiveObsidianCoreVersion };

export interface ObsidianHarness {
  page: Page;
  /**
   * Open a settings tab and return the page that renders it. Obsidian 1.13 moved
   * Settings into its own window, so this is not always the vault window.
   */
  openSettings(tabId?: string): Promise<Page>;
  /**
   * Every live Obsidian window. Obsidian mounts a modal in whichever window is
   * focused, so app-wide assertions must span all of them, not just the vault.
   */
  windows(): Page[];
  providerRequests(): number;
  close(): Promise<void>;
}

export interface ObsidianHarnessOptions {
  fakeClaudeCode?: boolean;
  /** Seed a genuinely fresh install: no credential, stock onboarding defaults. */
  firstRun?: boolean;
  /**
   * Stand up an OpenAI-compatible endpoint stub serving these model ids and
   * point `openaiCompatHost` at it (LM Studio / mlx-lm / vLLM stand-in).
   */
  endpointModels?: string[];
}

/** Where Obsidian keeps the cores it auto-updates into. */
function obsidianUserDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "obsidian");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian");
}

/**
 * The newest core Obsidian has already downloaded. The installed .app is only a
 * shell and loads this at runtime, so without it the harness reads the bundle's
 * version and refuses to run against a machine that is in fact up to date.
 */
async function discoverCoreAsar(): Promise<string | undefined> {
  const dir = obsidianUserDataDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const newest = newestCoreAsar(names);
  return newest ? join(dir, newest) : undefined;
}

/**
 * The plugin only loads on Obsidian >= manifest.minAppVersion. An older app
 * fails deep inside Obsidian (a 1.13-only settings tab has no display()), so
 * check the prerequisite up front and say what to do about it.
 */
async function assertSupportedObsidian(executable: string, coreAsarPath?: string): Promise<void> {
  const plist = executable.replace(/\/MacOS\/Obsidian$/, "/Info.plist");
  const { minAppVersion } = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8")) as { minAppVersion: string };
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

/** The container Obsidian renders a settings tab into, whichever window holds it. */
const SETTINGS_TAB = ".vertical-tab-content-container .vertical-tab-content";

/**
 * Ask Obsidian to open `tabId`, then resolve the window that actually rendered
 * it. Settings is a separate BrowserWindow on 1.13+ and part of the vault window
 * before that, so a spec must never assume which page holds the tab.
 */
async function openSettingsSurface(context: BrowserContext, page: Page, tabId: string): Promise<Page> {
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

function note(frontmatter: string, body: string): string { return `---\n${frontmatter}\n---\n\n${body}\n`; }

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("No port")); const port = address.port; server.close(() => resolve(port)); });
  });
}

async function seedVault(vault: string, providerPort: number, firstRun: boolean, endpointPort: number | null): Promise<void> {
  const obsidian = join(vault, ".obsidian"); const plugin = join(obsidian, "plugins", "claude-companion");
  await mkdir(plugin, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) await copyFile(join(process.cwd(), file), join(plugin, file));
  await writeFile(join(obsidian, "community-plugins.json"), JSON.stringify(["claude-companion"]));
  await writeFile(join(obsidian, "app.json"), JSON.stringify({ showUnsupportedFiles: true, alwaysUpdateLinks: true }));
  // E2E_SEED_DATA points at a real data.json so the suite can run against a
  // lived-in config, not just the pristine one a fresh install writes.
  const seeded = process.env.E2E_SEED_DATA ? JSON.parse(await readFile(process.env.E2E_SEED_DATA, "utf8")) as { settings?: Record<string, unknown> } : null;
  const neutralOnboarding = { ontologySeedPrompted: true, semanticModelPrompted: true, sourceCaptureConsent: "deny" };
  // An endpoint host with no model id is the reported bug's starting state.
  const endpoint = endpointPort === null ? {} : { openaiCompatHost: `http://127.0.0.1:${endpointPort}`, openaiCompatModel: "" };
  const settings = { apiKey: "e2e-key", authMode: "apiKey", baseUrl: `http://127.0.0.1:${providerPort}`, model: "e2e-model", customModel: "", chatBackend: "claude", discoveryEnabled: false, ...neutralOnboarding, ...endpoint };
  // firstRun keeps the stock onboarding defaults and no credential, so the
  // connect path the other specs skip past is actually exercised.
  const firstRunSettings = { authMode: "apiKey", baseUrl: `http://127.0.0.1:${providerPort}`, model: "e2e-model", customModel: "", chatBackend: "claude", discoveryEnabled: false };
  await writeFile(join(plugin, "data.json"), JSON.stringify(firstRun
    ? { settings: firstRunSettings, researchDeskPreferences: {} }
    : seeded
      ? { ...seeded, settings: { ...seeded.settings, apiKey: "e2e-key", baseUrl: `http://127.0.0.1:${providerPort}`, discoveryEnabled: false, ...neutralOnboarding } }
      : { settings, researchDeskPreferences: {} }));

  const alpha = join(vault, "Research", "Alpha");
  for (const folder of ["Sources", "Evidence", "Claims", "Questions", "Documents"]) await mkdir(join(alpha, folder), { recursive: true });
  await writeFile(join(alpha, "Project.md"), note('title: "Continuity research"\ntype: "research-project"\nproject: "[[Research/Alpha/Project.md]]"\nquestion: "How does evidence retain continuity?"\nstage: write\nstatus: active', "# Continuity research"));
  await writeFile(join(alpha, "Sources", "Study.md"), note('title: "Continuity study"\ntype: "research-source"\nproject: "[[Research/Alpha/Project.md]]"\nsource_kind: web\nurl: "https://example.test/study"\ncontent_fingerprint: "sha256:new"', "# Source\n\nCaptured study."));
  await writeFile(join(alpha, "Evidence", "Stale result.md"), note('title: "Stale result"\ntype: "evidence"\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nsource_fingerprint: "sha256:old"\nlocator_kind: page\nlocator_value: "4"\nreview_state: reviewed', "> Continuity improves with provenance."));
  await writeFile(join(alpha, "Evidence", "Challenge.md"), note('title: "Challenge"\ntype: "evidence"\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nlocator_kind: page\nlocator_value: "8"\nreview_state: proposed', "> Continuity varies by workflow."));
  await writeFile(join(alpha, "Claims", "Continuity claim.md"), note('title: "Continuity claim"\ntype: "claim"\nproject: "[[Research/Alpha/Project.md]]"\nproposition: "Provenance preserves continuity."\nconfidence: moderate\nreview_state: reviewed\nsupports:\n  - "[[Research/Alpha/Evidence/Stale result.md]]"\nchallenges:\n  - "[[Research/Alpha/Evidence/Challenge.md]]"\ncontextualizes: []\nlimitations:\n  - "One workflow was studied"', "# Claim"));
  await writeFile(join(alpha, "Questions", "Mechanism.md"), note('title: "Mechanism"\ntype: "research-question"\nproject: "[[Research/Alpha/Project.md]]"\nquestion: "Which mechanism matters?"\nstatus: open\nabout: "[[Research/Alpha/Claims/Continuity claim.md]]"', "# Open question"));
  await writeFile(join(alpha, "Documents", "Draft.md"), note('title: "White paper"\ntype: "research-document"\nproject: "[[Research/Alpha/Project.md]]"\ndocument_kind: draft\nclaims:\n  - "[[Research/Alpha/Claims/Continuity claim.md]]"', "# White paper\n\nDraft fixture."));

  const beta = join(vault, "Research", "Beta"); await mkdir(beta, { recursive: true });
  await writeFile(join(beta, "Project.md"), note('title: "Empty project"\ntype: "research-project"\nproject: "[[Research/Beta/Project.md]]"\nquestion: "What should we investigate?"\nstage: frame\nstatus: active', "# Empty project"));

  const longReference = join(vault, "Reference material with a deliberately long folder name");
  await mkdir(longReference, { recursive: true });
  await writeFile(join(longReference, "A very long note title that must truncate without widening the composer.md"), "# Long fixture\n");
  await writeFile(join(longReference, "Study.pdf"), Buffer.from("%PDF-1.4\n%e2e\n"));
  await writeFile(join(longReference, "Figure.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(join(vault, "Build plan.md"), "# Build plan\n\n- [ ] Create the parser\n- [ ] Wire the interface\n");
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return; } catch { /* app still starting */ } await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error("Obsidian did not expose its debugging endpoint");
}

export async function launchObsidianHarness(options: ObsidianHarnessOptions = {}): Promise<ObsidianHarness> {
  const root = await mkdtemp(join(tmpdir(), "claude-companion-e2e-")); const vault = join(root, "vault"); const profile = join(root, "profile"); await mkdir(vault, { recursive: true }); await mkdir(profile, { recursive: true });
  let requests = 0;
  const provider = createServer((request, response) => { requests += 1; request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ markdown: "Grounded prose [@study].", support: [], claimPreservation: [], changes: [], gaps: [] }) }] })); });
  await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", () => resolve()); });
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Provider stub did not bind");
  // OpenAI-compatible endpoint stub: only /v1/models matters for the pickers.
  let endpoint: Server | null = null;
  let endpointPort: number | null = null;
  if (options.endpointModels) {
    const ids = options.endpointModels;
    endpoint = createServer((request, response) => {
      request.resume();
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => { endpoint?.once("error", reject); endpoint?.listen(0, "127.0.0.1", () => resolve()); });
    const endpointAddress = endpoint.address();
    if (!endpointAddress || typeof endpointAddress === "string") throw new Error("Endpoint stub did not bind");
    endpointPort = endpointAddress.port;
  }
  await seedVault(vault, address.port, options.firstRun === true, endpointPort);
  let executablePath = process.env.PATH ?? "";
  if (options.fakeClaudeCode) {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const claude = join(bin, "claude");
    await writeFile(claude, `#!/bin/sh
case "$*" in
  *--version*) printf '2.1.226 (Claude Code)\\n' ;;
  *"plugin marketplace list --json"*) printf '[{"name":"cavi-ai","repo":"cavi-ai/plugins"}]\\n' ;;
  *"plugin list --json"*) printf '[{"id":"obsidian-agent@cavi-ai","enabled":true}]\\n' ;;
  *) sleep 0.4; printf '{"type":"result","result":"Fixture task completed"}\\n' ;;
esac
`);
    await chmod(claude, 0o755);
    executablePath = `${bin}:${executablePath}`;
  }
  await writeFile(join(profile, "obsidian.json"), JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }));
  const debuggingPort = await freePort();
  const executable = process.env.OBSIDIAN_APP_PATH ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  const coreAsarPath = process.env.OBSIDIAN_ASAR_PATH?.trim() || await discoverCoreAsar();
  await assertSupportedObsidian(executable, coreAsarPath);
  if (coreAsarPath) await copyFile(coreAsarPath, join(profile, basename(coreAsarPath)));
  const processHandle = spawn(executable, [vault, `--user-data-dir=${profile}`, `--remote-debugging-port=${debuggingPort}`, "--disable-gpu", "--no-sandbox"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: executablePath } });
  let processOutput = ""; processHandle.stdout?.on("data", (chunk) => { processOutput += String(chunk); }); processHandle.stderr?.on("data", (chunk) => { processOutput += String(chunk); });
  await waitForCdp(debuggingPort);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
  const context = browser.contexts()[0]; if (!context) throw new Error("Obsidian browser context not found");
  let page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md"));
  const deadline = Date.now() + 30_000;
  while (!page && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 250)); page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md")); }
  if (!page) throw new Error(`Obsidian page not found. ${processOutput.slice(-1000)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { app?: unknown }).app));
  const trustButton = page.getByRole("button", { name: "Trust author and enable plugins" });
  if (await trustButton.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
    await trustButton.click();
  }
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { commands?: { commands?: Record<string, unknown> } } }).app;
    return Boolean(app?.commands?.commands?.["claude-companion:open-research-desk"]);
  }, undefined, { timeout: 30_000 });
  // First-run prompts are intentionally sequential. A later prompt may mount
  // after the previous modal closes, so one missing 250 ms poll is not proof
  // that setup has settled. Wait for a sustained quiet period instead.
  // firstRun specs assert on those prompts, so nothing is dismissed for them.
  const setupDeadline = Date.now() + (options.firstRun ? 0 : 8_000);
  let quietSince = Date.now();
  while (Date.now() < setupDeadline && Date.now() - quietSince < 1_500) {
    const deferSetup = page.getByRole("button", { name: "Not now" }).last();
    const appeared = await deferSetup.waitFor({ state: "visible", timeout: 250 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) continue;
    await deferSetup.click();
    quietSince = Date.now();
  }
  // Accepting Obsidian's community-plugin trust prompt can leave an auxiliary
  // Settings BrowserWindow focused. Obsidian's Modal API then mounts dialogs
  // in that window even when Playwright clicks a control in the vault window.
  // Remove only that harness-created window so modal tests exercise one
  // deterministic renderer. First-run specs retain every onboarding surface.
  if (!options.firstRun) {
    for (const candidate of context.pages()) {
      if (candidate === page || candidate.isClosed()) continue;
      const title = await candidate.title().catch(() => "");
      if (title.startsWith("Settings - ")) await candidate.close();
    }
    await page.bringToFront();
  }
  return { page, openSettings: (tabId = "claude-companion") => openSettingsSurface(context, page, tabId), windows: () => context.pages().filter((candidate) => !candidate.isClosed()), providerRequests: () => requests, close: async () => { await browser.close().catch(() => undefined); await stop(processHandle); await closeServer(provider); if (endpoint) await closeServer(endpoint); await rm(root, { recursive: true, force: true }); } };
}

async function stop(handle: ChildProcess): Promise<void> { if (handle.exitCode !== null) return; handle.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => handle.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]); if (handle.exitCode === null) handle.kill("SIGKILL"); }
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
