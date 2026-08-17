import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface ObsidianHarness {
  page: Page;
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
  return { page, providerRequests: () => requests, close: async () => { await browser.close().catch(() => undefined); await stop(processHandle); await closeServer(provider); if (endpoint) await closeServer(endpoint); await rm(root, { recursive: true, force: true }); } };
}

async function stop(handle: ChildProcess): Promise<void> { if (handle.exitCode !== null) return; handle.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => handle.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]); if (handle.exitCode === null) handle.kill("SIGKILL"); }
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
