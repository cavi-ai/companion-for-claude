// First-run onboarding: the setup wizard, the one-shot consent prompts, and
// the ontology seeding and reload they drive.

import { normalizePath, Notice, TFile, type App } from "obsidian";
import type { OntologyRegistry } from "../ontology/registry";
import { planSeed, seedFiles } from "../ontology/seed";
import type { ProviderRouter } from "../providers/router";
import { credentialSetupInputs, needsCredentialSetup, type SetupInputs } from "../providers/setupState";
import type { SecretStore } from "../secrets/store";
import type { SemanticController } from "../semantic/controller";
import { DEFAULT_SETTINGS, type PluginSettings } from "../types";
import { ensureVaultFolder } from "../vault/vaultFiles";
import { ChoiceModal } from "../view/ChoiceModal";
import { SetupWizardModal, type SetupWizardDependencies } from "../view/SetupWizardModal";
import { pendingFirstRunPrompts, type FirstRunState } from "./firstRun";
import { wizardPlan, wizardPlanExplicit, WIZARD_DISMISSED_SETTINGS, type WizardState, type WizardStep } from "./wizard";

export interface OnboardingDeps {
  app: App;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  router: () => ProviderRouter;
  secrets: () => SecretStore;
  ontology: () => OntologyRegistry | null;
  semantic: () => SemanticController;
  openDesktopIntegrations: () => void;
  isMobile: () => boolean;
}

export class Onboarding {
  /** Layout-ready and the chat setup card can both continue onboarding; only one wizard may be open. */
  private setupWizardOpen = false;
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

  /** Settings-level view of what a fresh install still owes the user. */
  private firstRunState(): FirstRunState {
    const router = this.deps.router();
    return {
      needsCredential: needsCredentialSetup({
        backend: router.chatBackend,
        hasAnthropicCredential: router.anthropic.hasCredentials(),
        hasClaudeCli: router.claudeCli.hasCredentials(),
        hasCodexCli: router.codexCli.hasCredentials(),
        hasOpencodeCli: router.opencodeCli.hasCredentials(),
      }),
      ontologyPending: this.settings.ontologyEnabled && !this.settings.ontologySeedPrompted,
      semanticPending: this.settings.semanticEnabled && !this.settings.semanticModelPrompted,
      integrationsPending: !this.deps.isMobile() && !this.settings.desktopIntegrationsOffered,
    };
  }

  /**
   * Layout-ready first run: load the ontology, then the wizard (or the legacy
   * one-shot prompts). Awaits the in-flight Claude Code probe first — the
   * wizard's plan must never be computed off a stale credential read.
   */
  async runFirstRun(cliProbe?: Promise<unknown>): Promise<void> {
    await cliProbe;
    if (this.settings.ontologyEnabled) await this.loadOntologyOnStart();
    await this.continueOnboarding();
  }

  /**
   * Open the wizard for whatever auto-eligible steps remain (never the
   * connect step — while a credential is missing, `wizardPlan` is empty and
   * the chat setup card is the only step 1), else fall back to the legacy
   * one-shot prompts. Shared by layout-ready and by the chat setup card once
   * it has just saved a credential.
   */
  async continueOnboarding(): Promise<void> {
    if (!this.settings.setupWizardDone) {
      const steps = wizardPlan(this.wizardState());
      if (steps.length > 0) {
        this.openSetupWizardWithSteps(steps);
        return;
      }
    }
    await this.runFirstRunPrompts();
  }

  /** Settings-level view of what the setup wizard still has to offer. */
  private wizardState(): WizardState {
    const router = this.deps.router();
    return {
      needsCredential: needsCredentialSetup({
        backend: router.chatBackend,
        hasAnthropicCredential: router.anthropic.hasCredentials(),
        hasClaudeCli: router.claudeCli.hasCredentials(),
      }),
      isDesktop: !this.deps.isMobile(),
      desktopIntegrationsOffered: this.settings.desktopIntegrationsOffered,
      // A disabled feature has nothing left to decide, same as an already-prompted one.
      semanticModelPrompted: !this.settings.semanticEnabled || this.settings.semanticModelPrompted,
      ontologySeedPrompted: !this.settings.ontologyEnabled || this.settings.ontologySeedPrompted,
    };
  }

  /**
   * Command entry point: reopens the wizard for whatever is still pending,
   * including the connect step when a credential is missing — unlike the
   * auto path, the user asked for this directly.
   */
  openSetupWizard(): void {
    const steps = wizardPlanExplicit(this.wizardState());
    if (steps.length === 0) {
      new Notice("Nothing left to set up.");
      return;
    }
    this.openSetupWizardWithSteps(steps);
  }

  /**
   * The vault-tools step's own offer is spent the moment it is shown, same as
   * the legacy one-shot `offerDesktopIntegrations()` prompt it replaces —
   * regardless of which button the user ends up clicking.
   */
  private openSetupWizardWithSteps(steps: WizardStep[]): void {
    if (this.setupWizardOpen) return;
    this.setupWizardOpen = true;
    if (steps.includes("vault-tools") && !this.settings.desktopIntegrationsOffered) {
      this.settings.desktopIntegrationsOffered = true;
      void this.deps.saveSettings();
    }
    new SetupWizardModal(this.app, this.buildWizardDependencies(steps)).open();
  }

  private buildWizardDependencies(steps: WizardStep[]): SetupWizardDependencies {
    const router = this.deps.router();
    return {
      steps,
      storageBlurb: this.deps.secrets().available()
        ? "Stored in your device's secret storage, not in this vault."
        : "Stored locally in this vault's plugin data.",
      cliAvailable: router.claudeCli.available(),
      cliSignedIn: router.claudeCli.hasCredentials(),
      hasCredential: () => !needsCredentialSetup({
        backend: this.deps.router().chatBackend,
        hasAnthropicCredential: this.deps.router().anthropic.hasCredentials(),
        hasClaudeCli: this.deps.router().claudeCli.hasCredentials(),
      }),
      useClaudeCli: () => this.wizardUseClaudeCli(),
      saveApiKey: (key) => this.wizardSaveApiKey(key),
      ollamaHostDefault: DEFAULT_SETTINGS.ollamaHost,
      useLocal: (host) => this.wizardUseLocal(host),
      connectVaultTools: () => this.wizardConnectVaultTools(),
      agentAllowWrites: this.settings.agentAllowWrites,
      setAgentAllowWrites: (v) => this.wizardSetAgentWrites(v),
      semanticPending: this.settings.semanticEnabled && !this.settings.semanticModelPrompted,
      ontologyPending: this.settings.ontologyEnabled && !this.settings.ontologySeedPrompted,
      downloadEmbeddings: () => this.wizardDownloadEmbeddings(),
      seedOntology: () => this.wizardSeedOntology(),
      finish: () => this.wizardFinish(),
      onClosed: () => { this.setupWizardOpen = false; },
    };
  }

  private async wizardUseClaudeCli(): Promise<void> {
    this.settings.chatBackend = "claude-cli";
    await this.deps.saveSettings();
  }

  private async wizardSaveApiKey(key: string): Promise<{ ok: boolean; detail?: string }> {
    this.settings.authMode = "apiKey";
    this.settings.apiKey = key;
    await this.deps.saveSettings();
    const result = await this.deps.router().anthropic.test();
    return result.ok ? { ok: true } : { ok: false, detail: result.detail };
  }

  private async wizardUseLocal(host: string): Promise<void> {
    this.settings.chatBackend = "local";
    this.settings.ollamaHost = host;
    await this.deps.saveSettings();
  }

  /** Marks the offer spent, then reuses the real desktop-integrations flow. */
  private wizardConnectVaultTools(): void {
    this.settings.desktopIntegrationsOffered = true;
    void this.deps.saveSettings();
    this.deps.openDesktopIntegrations();
  }

  private async wizardSetAgentWrites(value: boolean): Promise<void> {
    this.settings.agentAllowWrites = value;
    await this.deps.saveSettings();
  }

  private async wizardDownloadEmbeddings(): Promise<void> {
    this.settings.semanticModelPrompted = true;
    await this.deps.saveSettings();
    await this.deps.semantic().downloadBuiltinModelAndIndex();
  }

  private async wizardSeedOntology(): Promise<void> {
    this.settings.ontologySeedPrompted = true;
    await this.deps.saveSettings();
    await this.seedOntology();
  }

  /** Both Finish and Skip/close call this — a dismissal doesn't reopen the wizard on its own. */
  private async wizardFinish(): Promise<void> {
    Object.assign(this.settings, WIZARD_DISMISSED_SETTINGS);
    await this.deps.saveSettings();
  }

  /**
   * Open the optional consent prompts one at a time, in order, skipping them
   * entirely while no credential exists. Each prompt keeps its own deeper
   * preconditions (registry already populated, model already cached).
   */
  async runFirstRunPrompts(): Promise<void> {
    for (const prompt of pendingFirstRunPrompts(this.firstRunState())) {
      if (prompt === "ontology") await this.offerOntologySeed();
      else if (prompt === "semantic") await this.deps.semantic().promptSemanticModelIfNeeded();
      else await this.offerDesktopIntegrations();
    }
  }

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
