import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface ObsidianHarness {
  page: Page;
  providerRequests(): number;
  close(): Promise<void>;
}

function note(frontmatter: string, body: string): string { return `---\n${frontmatter}\n---\n\n${body}\n`; }

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("No port")); const port = address.port; server.close(() => resolve(port)); });
  });
}

async function seedVault(vault: string, providerPort: number): Promise<void> {
  const obsidian = join(vault, ".obsidian"); const plugin = join(obsidian, "plugins", "claude-companion");
  await mkdir(plugin, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) await copyFile(join(process.cwd(), file), join(plugin, file));
  await writeFile(join(obsidian, "community-plugins.json"), JSON.stringify(["claude-companion"]));
  await writeFile(join(obsidian, "app.json"), JSON.stringify({ showUnsupportedFiles: true, alwaysUpdateLinks: true }));
  await writeFile(join(plugin, "data.json"), JSON.stringify({ settings: { apiKey: "e2e-key", authMode: "apiKey", baseUrl: `http://127.0.0.1:${providerPort}`, model: "e2e-model", customModel: "", chatBackend: "claude", discoveryEnabled: false }, researchDeskPreferences: {} }));

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
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return; } catch { /* app still starting */ } await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error("Obsidian did not expose its debugging endpoint");
}

export async function launchObsidianHarness(): Promise<ObsidianHarness> {
  const root = await mkdtemp(join(tmpdir(), "claude-companion-e2e-")); const vault = join(root, "vault"); const profile = join(root, "profile"); await mkdir(vault, { recursive: true }); await mkdir(profile, { recursive: true });
  let requests = 0;
  const provider = createServer((request, response) => { requests += 1; request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ markdown: "Grounded prose [@study].", support: [], claimPreservation: [], changes: [], gaps: [] }) }] })); });
  await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", () => resolve()); });
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Provider stub did not bind");
  await seedVault(vault, address.port);
  await writeFile(join(profile, "obsidian.json"), JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }));
  const debuggingPort = await freePort();
  const executable = process.env.OBSIDIAN_APP_PATH ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  const processHandle = spawn(executable, [vault, `--user-data-dir=${profile}`, `--remote-debugging-port=${debuggingPort}`, "--disable-gpu", "--no-sandbox"], { stdio: ["ignore", "pipe", "pipe"] });
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
  if (await trustButton.isVisible().catch(() => false)) await trustButton.click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { commands?: { commands?: Record<string, unknown> } } }).app;
    return Boolean(app?.commands?.commands?.["claude-companion:open-research-desk"]);
  }, undefined, { timeout: 30_000 });
  return { page, providerRequests: () => requests, close: async () => { await browser.close().catch(() => undefined); await stop(processHandle); await closeServer(provider); await rm(root, { recursive: true, force: true }); } };
}

async function stop(handle: ChildProcess): Promise<void> { if (handle.exitCode !== null) return; handle.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => handle.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]); if (handle.exitCode === null) handle.kill("SIGKILL"); }
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
