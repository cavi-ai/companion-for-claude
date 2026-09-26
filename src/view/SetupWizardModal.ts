import { App, Modal } from "obsidian";
import type { WizardStep } from "../onboarding/wizard";

const STEP_LABELS: Record<WizardStep, string> = {
  connect: "Connect",
  "vault-tools": "Vault tools",
  index: "Index",
};

export interface SetupWizardDependencies {
  /** Snapshot of the steps that still have something to decide, in order. */
  steps: WizardStep[];
  storageBlurb: string;
  cliAvailable: boolean;
  cliSignedIn: boolean;
  hasCredential(): boolean;
  useClaudeCli(): Promise<void>;
  saveApiKey(key: string): Promise<{ ok: boolean; detail?: string }>;
  ollamaHostDefault: string;
  useLocal(host: string): Promise<void>;
  connectVaultTools(): void;
  agentAllowWrites: boolean;
  setAgentAllowWrites(v: boolean): Promise<void>;
  semanticPending: boolean;
  ontologyPending: boolean;
  downloadEmbeddings(): Promise<void>;
  seedOntology(): Promise<void>;
  finish(): Promise<void>;
  onClosed(): void;
}

/** First-run wizard: one modal, three optional steps, over the same flags `firstRun.ts` orders. */
export class SetupWizardModal extends Modal {
  private current = 0;

  constructor(app: App, private readonly deps: SetupWizardDependencies) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.deps.onClosed();
  }

  private step(): WizardStep | undefined {
    return this.deps.steps[this.current];
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cc-setup-wizard-modal");
    this.titleEl.setText("Set up Claude Companion");

    if (this.deps.steps.length === 0) {
      contentEl.createEl("p", { text: "Nothing left to set up." });
      return;
    }

    const stepper = contentEl.createDiv({ cls: "cc-wizard-stepper" });
    stepper.setText(this.deps.steps.map((s, i) => `${i + 1} ${STEP_LABELS[s]}`).join(" · "));

    const body = contentEl.createDiv({ cls: "cc-wizard-body" });
    const step = this.step();
    if (step === "connect") this.renderConnect(body);
    else if (step === "vault-tools") this.renderVaultTools(body);
    else if (step === "index") this.renderIndex(body);

    this.renderFooter(contentEl);
  }

  private renderConnect(body: HTMLElement): void {
    body.createDiv({ cls: "cc-setup-title", text: "Connect to Claude" });
    body.createDiv({ cls: "cc-setup-sub", text: `Add a credential to start chatting. ${this.deps.storageBlurb}` });

    if (this.deps.cliAvailable && this.deps.cliSignedIn) {
      const useCli = body.createEl("button", { cls: "mod-cta cc-wizard-use-cli", text: "Use Claude Code sign-in" });
      useCli.addEventListener("click", () => void (async () => {
        await this.deps.useClaudeCli();
        this.next();
      })());
      body.createDiv({ cls: "cc-setup-or", text: "or" });
    }

    const row = body.createDiv({ cls: "cc-setup-row" });
    const input = row.createEl("input", {
      cls: "cc-setup-input",
      attr: { type: "password", placeholder: "sk-ant-api…", "aria-label": "Anthropic API key" },
    });
    const save = row.createEl("button", { cls: "mod-cta cc-wizard-save-key", text: "Save key" });
    const status = body.createDiv({ cls: "cc-setup-status" });
    save.addEventListener("click", () => void (async () => {
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      save.disabled = true;
      status.removeClass("is-err");
      status.setText("Checking your key…");
      const result = await this.deps.saveApiKey(key);
      save.disabled = false;
      if (!result.ok) {
        status.addClass("is-err");
        status.setText(`Couldn’t connect: ${result.detail ?? "unknown error"}`);
        input.focus();
        return;
      }
      status.setText("");
      this.next();
    })());

    body.createDiv({ cls: "cc-setup-or", text: "or" });
    const localRow = body.createDiv({ cls: "cc-setup-row" });
    const hostInput = localRow.createEl("input", {
      cls: "cc-setup-input",
      attr: { type: "text", placeholder: this.deps.ollamaHostDefault, "aria-label": "Ollama host" },
    });
    const useLocal = localRow.createEl("button", { text: "Use local model" });
    useLocal.addEventListener("click", () => void (async () => {
      await this.deps.useLocal(hostInput.value.trim() || this.deps.ollamaHostDefault);
      this.next();
    })());
  }

  private renderVaultTools(body: HTMLElement): void {
    body.createDiv({ cls: "cc-setup-title", text: "Vault tools" });
    const connect = body.createEl("button", { cls: "mod-cta cc-wizard-connect-tools", text: "Connect vault tools to Claude Code" });
    connect.addEventListener("click", () => { this.deps.connectVaultTools(); this.next(); });

    const writesRow = body.createDiv({ cls: "cc-wizard-toggle-row" });
    writesRow.createDiv({ cls: "cc-wizard-toggle-label", text: "Let the agent write to the vault (each write still asks for confirmation)" });
    const toggle = writesRow.createEl("input", { attr: { type: "checkbox", "aria-label": "Agent may write to the vault" } });
    toggle.checked = this.deps.agentAllowWrites;
    toggle.addEventListener("change", () => void this.deps.setAgentAllowWrites(toggle.checked));
  }

  private renderIndex(body: HTMLElement): void {
    body.createDiv({ cls: "cc-setup-title", text: "Index your vault" });
    if (this.deps.semanticPending) {
      const download = body.createEl("button", { cls: "mod-cta cc-wizard-download-embeddings", text: "Download the local embeddings model" });
      download.addEventListener("click", () => void (async () => {
        download.disabled = true;
        await this.deps.downloadEmbeddings();
        download.setText("Downloading…");
      })());
    }
    if (this.deps.ontologyPending) {
      const seedRow = body.createDiv({ cls: "cc-wizard-toggle-row" });
      seedRow.createDiv({ cls: "cc-wizard-toggle-label", text: "Seed vault ontology" });
      const seed = seedRow.createEl("input", { attr: { type: "checkbox", "aria-label": "Seed vault ontology" } });
      seed.addEventListener("change", () => { if (seed.checked) void this.deps.seedOntology(); });
    }
  }

  private renderFooter(contentEl: HTMLElement): void {
    const footer = contentEl.createDiv({ cls: "cc-wizard-footer" });
    if (this.current > 0) {
      const back = footer.createEl("button", { text: "Back" });
      back.addEventListener("click", () => { this.current -= 1; this.render(); });
    }
    const canSkip = this.step() !== "connect" || this.deps.hasCredential();
    const skip = footer.createEl("button", { text: "Skip" });
    skip.disabled = !canSkip;
    skip.addEventListener("click", () => this.next());

    const isLast = this.current >= this.deps.steps.length - 1;
    const advance = footer.createEl("button", { cls: "mod-cta", text: isLast ? "Finish" : "Next" });
    advance.addEventListener("click", () => this.next());
  }

  private next(): void {
    if (this.current >= this.deps.steps.length - 1) {
      void this.deps.finish();
      this.close();
      return;
    }
    this.current += 1;
    this.render();
  }
}
