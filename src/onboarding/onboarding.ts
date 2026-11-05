// Optional feature setup and ontology loading. Connection never starts a wizard.

import { normalizePath, Notice, TFile, type App } from "obsidian";
import type { OntologyRegistry } from "../ontology/registry";
import { planSeed, seedFiles } from "../ontology/seed";
import type { ProviderRouter } from "../providers/router";
import { credentialSetupInputs, type SetupInputs } from "../providers/setupState";
import type { SecretStore } from "../secrets/store";
import type { SemanticController } from "../semantic/controller";
import { type PluginSettings } from "../types";
import { ensureVaultFolder } from "../vault/vaultFiles";
import { ChoiceModal } from "../view/ChoiceModal";

export interface OnboardingDeps {
  app: App;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  router: () => ProviderRouter;
  secrets: () => SecretStore;
  ontology: () => OntologyRegistry | null;
  semantic: () => SemanticController;
  openDesktopIntegrations: () => void;
  openConnection: () => void;
  isMobile: () => boolean;
}

export class Onboarding {
  /** Debounce timer for ontology reloads on schema-note changes. */
  private ontologyReloadTimer: number | null = null;

  constructor(private deps: OnboardingDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Cancels a pending ontology reload. */
  dispose(): void {
    if (this.ontologyReloadTimer !== null) window.clearTimeout(this.ontologyReloadTimer);
  }

  /** Create missing default schema notes and upgrade unedited superseded ones (never overwrites edits), then reload and report. */
  async seedOntology(): Promise<void> {
    const folder = normalizePath(this.settings.ontologyFolder);
    await ensureVaultFolder(this.app, folder);
    const current = new Map<string, string | null>();
    for (const f of seedFiles()) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${f.fileName}`));
      current.set(f.fileName, file instanceof TFile ? await this.app.vault.read(file) : file ? "" : null);
    }
    let created = 0;
    let upgraded = 0;
    for (const w of planSeed((fileName) => current.get(fileName) ?? null)) {
      const path = normalizePath(`${folder}/${w.fileName}`);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (w.upgrade && file instanceof TFile) {
        await this.app.vault.modify(file, w.content);
        upgraded++;
      } else if (!w.upgrade && !file) {
        await this.app.vault.create(path, w.content);
        created++;
      }
    }
    const result = await this.deps.ontology()?.load();
    const errors = result?.errors ?? [];
    const changes = [created > 0 ? `seeded ${created}` : "", upgraded > 0 ? `upgraded ${upgraded}` : ""].filter(Boolean).join(", ");
    new Notice(changes ? `Ontology: ${changes} type${created + upgraded === 1 ? "" : "s"} → ${folder}/` : "Ontology already seeded — nothing to do.");
    if (errors.length > 0) {
      new Notice(`Ontology has ${errors.length} schema error${errors.length === 1 ? "" : "s"} — check the console.`);
      console.warn("[Claude Companion] ontology schema errors:", errors);
    }
  }

  /** Inputs for needsCredentialSetup; ChatView's send gate and System share them. */
  credentialSetupInputs(): SetupInputs {
    return credentialSetupInputs(this.deps.router());
  }

  /** Load existing schemas only. Optional setup runs when the user asks for that feature. */
  async runFirstRun(cliProbe?: Promise<unknown>): Promise<void> {
    await cliProbe;
    if (this.settings.ontologyEnabled) await this.loadOntologyOnStart();
  }

  /** Existing command identity now opens the single connection surface. */
  openSetupWizard(): void { this.deps.openConnection(); }

  /** Startup ontology load: surface schema errors instead of dropping them. */
  async loadOntologyOnStart(): Promise<void> {
    const registry = this.deps.ontology();
    if (!registry) return;
    const { errors } = await registry.load();
    if (errors.length > 0) {
      new Notice(`Ontology has ${errors.length} schema error${errors.length === 1 ? "" : "s"} — check the console.`);
      console.warn("[Claude Companion] ontology schema errors:", errors);
    }
  }

  /** One-time offer to write the default type schemas. Resolves when dismissed. */
  async offerOntologySeed(): Promise<void> {
    const registry = this.deps.ontology();
    if (!registry) return;
    if (registry.resolved().size > 0 || this.settings.ontologySeedPrompted) return;
    this.settings.ontologySeedPrompted = true;
    await this.deps.saveSettings();
    await new Promise<void>((resolve) => {
      new ChoiceModal<"seed" | "skip">(this.app, {
        title: "Set up the vault ontology",
        message:
          `The ontology lets Claude write typed notes (person, project, source…) that conform to schema notes in your vault. ` +
          `Create the default schemas in ${this.settings.ontologyFolder}/ now? You can edit or delete them afterwards, or re-run “Seed ontology” any time.`,
        buttons: [
          { label: "Create default schemas", value: "seed", cta: true },
          { label: "Not now", value: "skip" },
        ],
        fallback: "skip",
        onChoice: (c) => {
          if (c === "seed") void this.seedOntology();
          resolve();
        },
      }).open();
    });
  }

  /** One-time offer to wire Claude Code and Claude Desktop to this vault. Resolves when dismissed. */
  async offerDesktopIntegrations(): Promise<void> {
    if (this.deps.isMobile() || this.settings.desktopIntegrationsOffered) return;
    this.settings.desktopIntegrationsOffered = true;
    await this.deps.saveSettings();
    await new Promise<void>((resolve) => {
      new ChoiceModal<"open" | "skip">(this.app, {
        title: "Set up desktop integrations",
        message:
          "Install the obsidian-agent plugin for Claude Code and connect Claude Desktop to this vault. " +
          "Both are available later under Settings → Desktop integrations.",
        buttons: [
          { label: "Open desktop integrations", value: "open", cta: true },
          { label: "Not now", value: "skip" },
        ],
        fallback: "skip",
        onChoice: (c) => {
          if (c === "open") this.deps.openDesktopIntegrations();
          resolve();
        },
      }).open();
    });
  }

  /** Queue an ontology reload after schema-note changes (debounced ~500ms). */
  scheduleOntologyReload(): void {
    if (this.ontologyReloadTimer !== null) window.clearTimeout(this.ontologyReloadTimer);
    this.ontologyReloadTimer = window.setTimeout(() => {
      this.ontologyReloadTimer = null;
      void this.deps.ontology()?.load();
    }, 500);
  }
}
