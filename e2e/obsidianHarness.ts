import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { compareVersions, effectiveObsidianCoreVersion, newestCoreAsar } from "./coreAsar";

const execFileAsync = promisify(execFile);

export { effectiveObsidianCoreVersion };

export interface ObsidianHarness {
  page: Page;
  /** OS process identity, used to prove ordinary test leases share one launch. */
  processId: number;
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
  /** Where the fake claude logs its argv and stdin lines. */
  argvLog: string;
  /** The temp vault and Electron profile this launch uses. */
  paths: { vault: string; profile: string };
  close(options?: { keep?: boolean }): Promise<void>;
}

export interface ObsidianHarnessOptions {
  fakeClaudeCode?: boolean;
  /** Seed the Claude Code backend with a fake claude that speaks stream-json. */
  claudeCli?: boolean;
  /** Chat on the real, signed-in claude binary. Spends subscription usage. */
  liveClaude?: boolean;
  /** Seed a genuinely fresh install: no credential, stock onboarding defaults. */
  firstRun?: boolean;
  /**
   * Stand up an OpenAI-compatible endpoint stub serving these model ids and
   * point `openaiCompatHost` at it (LM Studio / mlx-lm / vLLM stand-in).
   */
  endpointModels?: string[];
  /** Product-real reply copy for an OpenAI-compatible endpoint scene. */
  endpointReply?: string;
  /** Relaunch on a previous harness's vault + profile without re-seeding. */
  reuse?: { vault: string; profile: string };
  /** Answer a provider request by its raw body; null falls through to the default payload. */
  providerReply?: (body: string) => string | null;
  /** Answer a provider request with this HTTP status instead of a body; null → normal reply. Called once per request. */
  providerFail?: (body: string) => number | null;
  /** Delay the provider stub's response by this many ms, to simulate a real model call. */
  providerDelayMs?: number;
  /** Extra vault files written before launch: relative path → content. */
  extraFiles?: Record<string, string>;
  /** Settings merged over the seeded plugin settings (last write wins). */
  settingsOverride?: Record<string, unknown>;
  /** Serve an Ollama-compatible /api/embed stub and point the built-in engine at it (engine "ollama"). */
  embedStub?: boolean;
  /** Obsidian appearance for the seeded profile; default follows a fresh install. */
  theme?: "light" | "dark";
  /** Keep the Obsidian window unfocused and off-screen; default on unless CC_E2E_SHOW=1. */
  hidden?: boolean;
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

/**
 * Resize the right sidebar (where the chat pane docks) to `px` for narrow-pane
 * layout tests. Prefers `rightSplit.setSize`, then pins the split's CSS width so
 * repeated documentation captures cannot inherit a previous workspace size.
 */
export async function setRightSidebarWidth(page: Page, px: number): Promise<void> {
  await page.evaluate((size) => {
    const w = window as unknown as {
      app: {
        workspace: {
          rightSplit: { setSize?(px: number): void; containerEl: HTMLElement };
          onLayoutChange(): void;
        };
      };
    };
    const rightSplit = w.app.workspace.rightSplit;
    if (typeof rightSplit.setSize === "function") {
      rightSplit.setSize(size);
    }
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

function note(frontmatter: string, body: string): string { return `---\n${frontmatter}\n---\n\n${body}\n`; }

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("No port")); const port = address.port; server.close(() => resolve(port)); });
  });
}

async function seedVault(vault: string, providerPort: number, firstRun: boolean, endpointPort: number | null, claudeCli = false, live = false, embedPort: number | null = null, settingsOverride: Record<string, unknown> = {}, theme?: "light" | "dark"): Promise<void> {
  const obsidian = join(vault, ".obsidian"); const plugin = join(obsidian, "plugins", "claude-companion");
  await mkdir(plugin, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) await copyFile(join(process.cwd(), file), join(plugin, file));
  await writeFile(join(obsidian, "community-plugins.json"), JSON.stringify(["claude-companion"]));
  await writeFile(join(obsidian, "app.json"), JSON.stringify({ showUnsupportedFiles: true, alwaysUpdateLinks: true }));
  if (theme) {
    const appearancePath = join(obsidian, "appearance.json");
    const existing = await readFile(appearancePath, "utf8").then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => ({}) as Record<string, unknown>);
    await writeFile(appearancePath, JSON.stringify({ ...existing, theme: theme === "dark" ? "obsidian" : "moonstone" }));
  }
  // E2E_SEED_DATA points at a real data.json so the suite can run against a
  // lived-in config, not just the pristine one a fresh install writes.
  const seeded = process.env.E2E_SEED_DATA ? JSON.parse(await readFile(process.env.E2E_SEED_DATA, "utf8")) as { settings?: Record<string, unknown> } : null;
  const neutralOnboarding = { ontologySeedPrompted: true, semanticModelPrompted: true, sourceCaptureConsent: "deny", desktopIntegrationsOffered: true };
  // An endpoint host with no model id is the reported bug's starting state.
  const endpoint = endpointPort === null ? {} : { openaiCompatHost: `http://127.0.0.1:${endpointPort}`, openaiCompatModel: "" };
  // The live binary 404s on a placeholder model id; omit it so the plugin's own default applies.
  const modelFields = live ? {} : { model: "e2e-model", customModel: "" };
  // The embed stub answers /api/embed with a deterministic vector so the built-in
  // engine can be pointed at "ollama" without a real Ollama install.
  const embed = embedPort === null ? {} : { embeddingEngine: "ollama", ollamaHost: `http://127.0.0.1:${embedPort}`, embeddingModel: "stub-embed", semanticEnabled: true };
  const settings = { apiKey: claudeCli ? "" : "e2e-key", authMode: "apiKey", baseUrl: `http://127.0.0.1:${providerPort}`, ...modelFields, chatBackend: claudeCli ? "claude-cli" : "claude", discoveryEnabled: false, ...neutralOnboarding, ...endpoint, ...embed, ...settingsOverride };
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

/** Repoint a reused vault's stub connection settings at this launch's (freshly rolled) ports. */
async function patchReuseConnectionSettings(vault: string, providerPort: number, endpointPort: number | null, embedPort: number | null): Promise<void> {
  const dataPath = join(vault, ".obsidian", "plugins", "claude-companion", "data.json");
  const raw = JSON.parse(await readFile(dataPath, "utf8")) as { settings?: Record<string, unknown> };
  if (!raw.settings) return;
  raw.settings.baseUrl = `http://127.0.0.1:${providerPort}`;
  if (endpointPort !== null) raw.settings.openaiCompatHost = `http://127.0.0.1:${endpointPort}`;
  if (embedPort !== null) raw.settings.ollamaHost = `http://127.0.0.1:${embedPort}`;
  await writeFile(dataPath, JSON.stringify(raw));
}

/** A cheap, seeded-hash embedding vector — deterministic, not a real model's output. */
function deterministicVector(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash += text.charCodeAt(i);
  const v: number[] = [];
  for (let i = 0; i < 384; i++) v.push(((hash * (i + 1)) % 1000) / 1000 - 0.5);
  return v;
}

let hideWarned = false;
/** Deactivate the Obsidian process without a real OS-level hide (that pauses the Chromium renderer and blanks screenshots); a failure is logged once and the run stays visible. */
async function hideAppWindow(pid: number): Promise<void> {
  try {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to false`]);
  } catch (error) {
    if (!hideWarned) { hideWarned = true; console.warn("obsidianHarness: could not unfocus the Obsidian window, run stays visible:", error); }
  }
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return; } catch { /* app still starting */ } await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error("Obsidian did not expose its debugging endpoint");
}

async function settleObsidianPage(context: BrowserContext, page: Page, firstRun: boolean, hidden: boolean, pid?: number, checkTrust = true): Promise<void> {
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

interface PhysicalObsidianHarness extends ObsidianHarness {
  reset(options: ObsidianHarnessOptions): Promise<void>;
  shutdown(options?: { keep?: boolean }): Promise<void>;
  killNow(): void;
}

let pooledHarness: PhysicalObsidianHarness | null = null;
let pooledLeaseActive = false;

export async function shutdownSharedObsidianHarness(): Promise<void> {
  const physical = pooledHarness;
  pooledHarness = null;
  pooledLeaseActive = false;
  await physical?.shutdown();
}

function needsStandaloneProcess(options: ObsidianHarnessOptions): boolean {
  // These scenarios assert startup or process-death behavior. Reusing the
  // ordinary worker process would remove the lifecycle boundary under test.
  return options.firstRun === true || options.liveClaude === true || options.reuse !== undefined;
}

async function launchFreshObsidianHarness(options: ObsidianHarnessOptions = {}, pooled = false): Promise<PhysicalObsidianHarness> {
  let activeOptions = options;
  const hidden = options.hidden ?? process.env.CC_E2E_SHOW !== "1";
  const root = options.reuse ? dirname(options.reuse.vault) : await mkdtemp(join(tmpdir(), "claude-companion-e2e-"));
  const vault = options.reuse?.vault ?? join(root, "vault"); const profile = options.reuse?.profile ?? join(root, "profile");
  if (!options.reuse) { await mkdir(vault, { recursive: true }); await mkdir(profile, { recursive: true }); }
  let requests = 0;
  const defaultReply = JSON.stringify({ markdown: "Grounded prose [@study].", support: [], claimPreservation: [], changes: [], gaps: [] });
  const provider = createServer((request, response) => { requests += 1; let body = ""; request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); }); request.on("end", () => { const status = activeOptions.providerFail?.(body) ?? null; if (status !== null) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `stubbed ${status}` } })); return; } const text = activeOptions.providerReply?.(body) ?? defaultReply; const respond = () => { if (/"stream"\s*:\s*true/.test(body)) { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`); response.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`); response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`); return; } response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ content: [{ type: "text", text }] })); }; if (activeOptions.providerDelayMs) setTimeout(respond, activeOptions.providerDelayMs); else respond(); }); });
  await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", () => resolve()); });
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Provider stub did not bind");
  // OpenAI-compatible endpoint stub: /v1/models for the pickers, /v1/chat/completions
  // (stream + non-stream) so a real chat turn against it can actually answer.
  let endpoint: Server | null = null;
  let endpointPort: number | null = null;
  if (options.endpointModels || pooled) {
    endpoint = createServer((request, response) => {
      // stream() (unlike listModels()/complete(), which go through Obsidian's
      // requestUrl) calls the real browser fetch(), so a JSON POST triggers a
      // CORS preflight — answer it, and mark every response CORS-open.
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") {
        request.resume();
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization" });
        response.end();
        return;
      }
      if (request.url?.endsWith("/models")) {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: (activeOptions.endpointModels ?? []).map((id) => ({ id, object: "model" })) }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
        let body = "";
        request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        request.on("end", () => {
          const streaming = /"stream"\s*:\s*true/.test(body);
          if (streaming) {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: activeOptions.endpointReply ?? "Answered locally by the endpoint stub." } }] })}\n\n`);
            response.write("data: [DONE]\n\n");
            response.end();
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ choices: [{ message: { content: activeOptions.endpointReply ?? "Answered locally by the endpoint stub." } }] }));
          }
        });
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => { endpoint?.once("error", reject); endpoint?.listen(0, "127.0.0.1", () => resolve()); });
    const endpointAddress = endpoint.address();
    if (!endpointAddress || typeof endpointAddress === "string") throw new Error("Endpoint stub did not bind");
    endpointPort = endpointAddress.port;
  }
  // Ollama-compatible embed stub: /api/embed (deterministic vectors) and /api/tags
  // (so the model picker + "reachable" check see one model, "stub-embed").
  let embed: Server | null = null;
  let embedPort: number | null = null;
  if (options.embedStub || pooled) {
    embed = createServer((request, response) => {
      if (request.method === "GET" && request.url?.endsWith("/api/tags")) {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ name: "stub-embed" }] }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/api/embed")) {
        let body = "";
        request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        request.on("end", () => {
          const { input } = JSON.parse(body || "{}") as { input?: string[] };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ embeddings: (input ?? []).map(deterministicVector) }));
        });
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => { embed?.once("error", reject); embed?.listen(0, "127.0.0.1", () => resolve()); });
    const embedAddress = embed.address();
    if (!embedAddress || typeof embedAddress === "string") throw new Error("Embed stub did not bind");
    embedPort = embedAddress.port;
  }
  if (!options.reuse) {
    await seedVault(vault, address.port, options.firstRun === true, options.endpointModels ? endpointPort : null, options.claudeCli === true || options.liveClaude === true, options.liveClaude === true, options.embedStub ? embedPort : null, options.settingsOverride ?? {}, options.theme);
  } else {
    // Stub server ports are re-rolled every launch; a reused vault's data.json still
    // names the previous launch's (now-closed) ports, so every provider/embed call
    // would connection-refuse. Repoint just the connection fields at this launch's servers.
    await patchReuseConnectionSettings(vault, address.port, endpointPort, embedPort);
  }
  if (options.extraFiles) {
    for (const [rel, content] of Object.entries(options.extraFiles)) {
      const dest = join(vault, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }
  }
  let executablePath = process.env.PATH ?? "";
  // The real binary lives in ~/.local/bin, which Obsidian's own PATH lacks.
  if (options.liveClaude) executablePath = `${join(homedir(), ".local", "bin")}:${executablePath}`;
  if (!options.liveClaude && (options.fakeClaudeCode || options.claudeCli || pooled)) {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const claude = join(bin, "claude");
    await writeFile(claude, `#!/bin/sh
log="$(dirname "$0")/claude-argv.log"
case "$*" in
  *--version*) printf '2.1.257 (Claude Code)\\n' ;;
  *"auth status"*) printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\\n' ;;
  *"plugin marketplace list --json"*) printf '[{"name":"cavi-ai","repo":"cavi-ai/plugins"}]\\n' ;;
  *"plugin list --json"*) printf '[{"id":"obsidian-agent@cavi-ai","enabled":true}]\\n' ;;
  *"--input-format stream-json"*)
    printf 'ARGV %s\\n' "$*" >> "$log"
    while IFS= read -r line; do
      printf 'STDIN %s\\n' "$line" >> "$log"
      case "$line" in
        *"make it fail"*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"result","subtype":"success","result":"There is an issue with the selected model (e2e-model).","session_id":"e2e-session","num_turns":1,"is_error":true,"api_error_status":404,"usage":{"input_tokens":0,"output_tokens":0}}\\n' ;;
        *"hang forever"*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          trap '' INT TERM
          while :; do sleep 1; done ;;
        *"weakens my continuity claim"*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__obsidian-vault__vault_search","input":{"query":"challenges continuity claim"}}]}}\\n'
          printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Research/Alpha/Evidence/Challenge.md — proposed evidence"}]}}\\n'
          printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"mcp__obsidian-vault__note_read","input":{"path":"Research/Alpha/Evidence/Challenge.md"}}]}}\\n'
          printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"> Continuity varies by workflow.\\\\n\\\\nLocator: p. 8 · Review: proposed"}]}}\\n'
          printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Your weakest point is scope: the evidence says continuity varies by workflow, so “provenance preserves continuity” is too absolute. Narrow the claim to the workflows where source links remain intact, then review the proposed evidence on page 8."}}}\\n'
          printf '{"type":"result","subtype":"success","result":"Your weakest point is scope: the evidence says continuity varies by workflow, so “provenance preserves continuity” is too absolute. Narrow the claim to the workflows where source links remain intact, then review the proposed evidence on page 8.","session_id":"e2e-session","num_turns":1,"is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}\\n' ;;
        *)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong from claude code"}}}\\n'
          printf '{"type":"result","subtype":"success","result":"pong from claude code","session_id":"e2e-session","num_turns":1,"is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}\\n' ;;
      esac
    done ;;
  *) sleep 0.4; printf '{"type":"result","result":"Fixture task completed"}\\n' ;;
esac
`);
    await chmod(claude, 0o755);
    executablePath = `${bin}:${executablePath}`;
  }
  if (!options.reuse) await writeFile(join(profile, "obsidian.json"), JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }));
  const debuggingPort = await freePort();
  const executable = process.env.OBSIDIAN_APP_PATH ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  const coreAsarPath = process.env.OBSIDIAN_ASAR_PATH?.trim() || await discoverCoreAsar();
  await assertSupportedObsidian(executable, coreAsarPath);
  if (coreAsarPath) await copyFile(coreAsarPath, join(profile, basename(coreAsarPath)));
  const hiddenArgs = hidden ? ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--window-position=-4000,-4000"] : [];
  const processHandle = spawn(executable, [vault, `--user-data-dir=${profile}`, `--remote-debugging-port=${debuggingPort}`, "--disable-gpu", "--no-sandbox", ...hiddenArgs], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: executablePath } });
  if (!processHandle.pid) throw new Error("Obsidian process did not start");
  let processOutput = ""; processHandle.stdout?.on("data", (chunk) => { processOutput += String(chunk); }); processHandle.stderr?.on("data", (chunk) => { processOutput += String(chunk); });
  await waitForCdp(debuggingPort);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
  const context = browser.contexts()[0]; if (!context) throw new Error("Obsidian browser context not found");
  let page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md"));
  const deadline = Date.now() + 30_000;
  while (!page && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 250)); page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md")); }
  if (!page) throw new Error(`Obsidian page not found. ${processOutput.slice(-1000)}`);
  await settleObsidianPage(context, page, options.firstRun === true, hidden, processHandle.pid);

  const argvLog = join(root, "bin", "claude-argv.log");
  const shutdown = async ({ keep = false }: { keep?: boolean } = {}): Promise<void> => {
    await browser.close().catch(() => undefined);
    await stop(processHandle);
    await closeServer(provider);
    if (endpoint) await closeServer(endpoint);
    if (embed) await closeServer(embed);
    if (!keep) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  const reset = async (nextOptions: ObsidianHarnessOptions): Promise<void> => {
    activeOptions = nextOptions;
    for (const candidate of context.pages()) {
      if (candidate !== page && !candidate.isClosed()) await candidate.close();
    }
    for (let attempt = 0; attempt < 6 && await page.locator(".modal-container").count(); attempt += 1) {
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => {
      const app = (window as unknown as {
        app: {
          plugins: { disablePlugin(id: string): Promise<void> };
          workspace: { getLeavesOfType(type: string): Array<{ detach(): void }> };
        };
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
    await seedVault(vault, address.port, false, nextOptions.endpointModels ? endpointPort : null, nextOptions.claudeCli === true, false, nextOptions.embedStub ? embedPort : null, nextOptions.settingsOverride ?? {}, nextOptions.theme);
    const dataPath = join(vault, ".obsidian", "plugins", "claude-companion", "data.json");
    const data = JSON.parse(await readFile(dataPath, "utf8")) as { settings?: Record<string, unknown> };
    if (data.settings) delete data.settings.apiKey;
    await writeFile(dataPath, JSON.stringify(data));
    if (nextOptions.extraFiles) {
      for (const [rel, content] of Object.entries(nextOptions.extraFiles)) {
        const dest = join(vault, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content);
      }
    }
    await writeFile(argvLog, "");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(async (theme) => {
      document.body.classList.remove("theme-light", "theme-dark");
      document.body.classList.add(theme === "dark" ? "theme-dark" : "theme-light");
      const app = (window as unknown as {
        app: { plugins: { enablePlugin(id: string): Promise<void> } };
      }).app;
      await app.plugins.enablePlugin("claude-companion");
    }, nextOptions.theme ?? "light");
    await settleObsidianPage(context, page, false, nextOptions.hidden ?? process.env.CC_E2E_SHOW !== "1", processHandle.pid, false);
    await page.evaluate(() => {
      document.querySelectorAll(".notice").forEach((notice) => notice.remove());
      document.body.classList.remove("is-mobile");
      const rightSplit = document.querySelector<HTMLElement>(".workspace-split.mod-right-split");
      for (const property of ["display", "position", "inset", "width", "min-width", "max-width", "flex", "z-index"]) {
        rightSplit?.style.removeProperty(property);
      }
      const workspace = (window as unknown as {
        app: {
          workspace: {
            leftSplit: { setSize?(px: number): void };
            rightSplit: { setSize?(px: number): void };
            onLayoutChange(): void;
          };
        };
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
  };
  return {
    page,
    processId: processHandle.pid,
    openSettings: (tabId = "claude-companion") => openSettingsSurface(context, page, tabId),
    windows: () => context.pages().filter((candidate) => !candidate.isClosed()),
    providerRequests: () => requests,
    argvLog,
    paths: { vault, profile },
    close: shutdown,
    reset,
    shutdown,
    killNow: () => {
      processHandle.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export async function launchObsidianHarness(options: ObsidianHarnessOptions = {}): Promise<ObsidianHarness> {
  if (needsStandaloneProcess(options)) return launchFreshObsidianHarness(options);
  if (pooledLeaseActive) throw new Error("The shared Obsidian E2E session already has an active test lease");
  if (!pooledHarness) {
    // Bootstrap one encrypted test credential and all optional stub transports.
    // Every ordinary test thereafter receives a clean logical lease.
    pooledHarness = await launchFreshObsidianHarness({}, true);
    process.once("exit", () => {
      pooledHarness?.killNow();
    });
  }
  await pooledHarness.reset(options);
  pooledLeaseActive = true;
  const requestBaseline = pooledHarness.providerRequests();
  const physical = pooledHarness;
  return {
    ...physical,
    providerRequests: () => physical.providerRequests() - requestBaseline,
    close: async ({ keep = false } = {}) => {
      if (keep) {
        pooledHarness = null;
        pooledLeaseActive = false;
        await physical.shutdown({ keep: true });
        return;
      }
      pooledLeaseActive = false;
    },
  };
}

async function stop(handle: ChildProcess): Promise<void> { if (handle.exitCode !== null) return; handle.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => handle.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]); if (handle.exitCode === null) handle.kill("SIGKILL"); }
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
