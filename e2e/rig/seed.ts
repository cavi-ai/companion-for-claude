// Vault seeding: fixture notes + plugin data.json, shared by the daemon's
// first launch and the fixture's per-scenario reset. Pure fs, no CDP.

import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioOptions, StubPorts } from "./types.ts";

function note(frontmatter: string, body: string): string { return `---\n${frontmatter}\n---\n\n${body}\n`; }

/** A cheap, seeded-hash embedding vector — deterministic, not a real model's output. */
export function deterministicVector(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash += text.charCodeAt(i);
  const v: number[] = [];
  for (let i = 0; i < 384; i++) v.push(((hash * (i + 1)) % 1000) / 1000 - 0.5);
  return v;
}

/** Copy the freshly built plugin (main.js/manifest.json/styles.css) into the rig vault, from `buildDir` (the plugin package root). */
export async function installPluginBuild(vault: string, buildDir: string): Promise<void> {
  const plugin = join(vault, ".obsidian", "plugins", "claude-companion");
  await mkdir(plugin, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) await copyFile(join(buildDir, file), join(plugin, file));
}

export async function seedVault(vault: string, ports: StubPorts, options: ScenarioOptions, buildDir: string): Promise<void> {
  const obsidian = join(vault, ".obsidian");
  await installPluginBuild(vault, buildDir);
  const plugin = join(obsidian, "plugins", "claude-companion");
  await writeFile(join(obsidian, "community-plugins.json"), JSON.stringify(["claude-companion"]));
  // safeMode: false pre-answers "Trust author and enable plugins" — without it,
  // a vault opened for the first time with community plugins listed always
  // shows that dialog before the plugin can load.
  await writeFile(join(obsidian, "app.json"), JSON.stringify({ showUnsupportedFiles: true, alwaysUpdateLinks: true, safeMode: false }));
  if (options.theme) {
    const appearancePath = join(obsidian, "appearance.json");
    const existing = await readFile(appearancePath, "utf8").then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => ({}) as Record<string, unknown>);
    await writeFile(appearancePath, JSON.stringify({ ...existing, theme: options.theme === "dark" ? "obsidian" : "moonstone" }));
  }
  const firstRun = options.firstRun === true;
  const claudeCli = options.claudeCli === true || options.liveClaude === true;
  const live = options.liveClaude === true;
  const neutralOnboarding = { ontologySeedPrompted: true, semanticModelPrompted: true, sourceCaptureConsent: "deny", desktopIntegrationsOffered: true, settingsShowAdvanced: true };
  // An endpoint host with no model id is the reported bug's starting state.
  const endpoint = options.endpointModels === undefined ? {} : { openaiCompatHost: `http://127.0.0.1:${ports.endpointPort}`, openaiCompatModel: "" };
  // The live binary 404s on a placeholder model id; omit it so the plugin's own default applies.
  const modelFields = live ? {} : { model: "e2e-model", customModel: "" };
  // The embed stub answers /api/embed with a deterministic vector so the built-in
  // engine can be pointed at "ollama" without a real Ollama install.
  const embed = !options.embedStub ? {} : { embeddingEngine: "ollama", ollamaHost: `http://127.0.0.1:${ports.embedPort}`, embeddingModel: "stub-embed", semanticEnabled: true };
  const settings = { apiKey: claudeCli ? "" : "e2e-key", authMode: "apiKey", baseUrl: `http://127.0.0.1:${ports.providerPort}`, ...modelFields, chatBackend: claudeCli ? "claude-cli" : "claude", discoveryEnabled: false, ...neutralOnboarding, ...endpoint, ...embed, ...(options.settingsOverride ?? {}) };
  // firstRun keeps the stock onboarding defaults and no credential, so the
  // connect path the other specs skip past is actually exercised.
  const firstRunSettings = { authMode: "apiKey", baseUrl: `http://127.0.0.1:${ports.providerPort}`, model: "e2e-model", customModel: "", chatBackend: "claude", discoveryEnabled: false };
  await writeFile(join(plugin, "data.json"), JSON.stringify(firstRun
    ? { settings: firstRunSettings, researchDeskPreferences: {} }
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

  if (options.extraFiles) {
    for (const [rel, content] of Object.entries(options.extraFiles)) {
      const dest = join(vault, rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, content);
    }
  }
}
