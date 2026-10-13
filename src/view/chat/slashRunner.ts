import { MarkdownView, Notice, type App, type EventRef } from "obsidian";
import type { ContextToggles } from "../../types";
import { substitutePlaceholders } from "../../templates/promptTemplates";
import { WORKFLOWS } from "../../workflows/catalog";
import { SKILLS } from "../../workflows/skillRegistry.generated";
import { buildSlashCatalog, dispatchSlashAction, SKILL_ACTION_PREFIX, WORKFLOW_ACTION_PREFIX, type SlashCommand } from "../slashCommands";
import type { ChatViewHost } from "./hosts";

export type SlashRunnerHost = Pick<ChatViewHost, "promptTemplates" | "views" | "commandActions" | "settings">;

export interface SlashRunnerDeps {
  clearInput(): void;
  setDraft(text: string): void;
  updateUsageBar(): void;
  submitPrompt(text: string, display?: string, maxTokens?: number, opts?: { model?: string; context?: Partial<ContextToggles> }): Promise<boolean>;
  setCommands(commands: SlashCommand[]): void;
  view: { newChat(): void; openHistory(): void; save(): Promise<void>; askVault(): void };
}

/** The slash-command catalog (workflows, skills, user templates) and the execution of a chosen command. */
export class SlashRunner {
  private reloadGeneration = 0;

  constructor(private app: App, private plugin: SlashRunnerHost, private deps: SlashRunnerDeps) {}

  initialCatalog(): SlashCommand[] {
    return buildSlashCatalog(WORKFLOWS, SKILLS, []);
  }

  /** Loads the templates now and again whenever a note in the templates folder changes. */
  watch(register: (ref: EventRef) => void): void {
    void this.reload();
    const templateTouched = (file: { path: string }): boolean =>
      file.path.startsWith(`${this.plugin.settings.templatesFolder.replace(/\/+$/, "")}/`);
    const scheduleTemplateReload = (file: { path: string }) => {
      if (templateTouched(file)) void this.reload();
    };
    register(this.app.vault.on("create", scheduleTemplateReload));
    register(this.app.vault.on("modify", scheduleTemplateReload));
    register(this.app.vault.on("delete", scheduleTemplateReload));
    register(this.app.vault.on("rename", (file, oldPath) => {
      if (templateTouched(file) || templateTouched({ path: oldPath })) void this.reload();
    }));
  }

  dispose(): void {
    this.reloadGeneration++;
  }

  /** Re-read the templates folder and rebuild the slash catalog (templates last). */
  async reload(): Promise<void> {
    const generation = ++this.reloadGeneration;
    const templates = await this.plugin.promptTemplates();
    if (generation !== this.reloadGeneration) return;
    this.deps.setCommands(buildSlashCatalog(WORKFLOWS, SKILLS, templates));
  }

  /** Execute a chosen slash command — either send a prompt or run an action. */
  async run(cmd: SlashCommand): Promise<void> {
    this.deps.clearInput();

    // User template: substitute placeholders against the live editor state,
    // then send with the note's optional model/context overrides for this turn.
    if (cmd.template) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selection = view?.editor.getSelection() ?? "";
      const activeNote = view?.file ? await this.app.vault.cachedRead(view.file) : "";
      const prompt = substitutePlaceholders(cmd.template.prompt, { selection, activeNote });
      await this.deps.submitPrompt(prompt, `/${cmd.name}`, undefined, {
        ...(cmd.template.model ? { model: cmd.template.model } : {}),
        ...(cmd.template.context ? { context: cmd.template.context } : {}),
      });
      return;
    }

    if (cmd.kind === "prompt" && cmd.prompt) {
      if (cmd.awaitsInput) {
        // Insert the template and let the user finish typing (e.g. "/explain ").
        this.deps.setDraft(cmd.prompt);
        this.deps.updateUsageBar();
        return;
      }
      // Hide the verbose template behind the command name; the model still gets cmd.prompt.
      await this.deps.submitPrompt(cmd.prompt, `/${cmd.name}`);
      return;
    }

    // A skill takes arguments: insert its token and let the user finish typing; Enter sends through onSend.
    if (cmd.action?.startsWith(SKILL_ACTION_PREFIX)) {
      this.deps.setDraft(`/${cmd.action.slice(SKILL_ACTION_PREFIX.length)} `);
      this.deps.updateUsageBar();
      return;
    }

    // A workflow slash command ("/manifest-pm", "/frontmatter-audit", …) runs the
    // matching catalog workflow directly.
    if (cmd.action?.startsWith(WORKFLOW_ACTION_PREFIX)) {
      const id = cmd.action.slice(WORKFLOW_ACTION_PREFIX.length);
      const wf = WORKFLOWS.find((w) => w.id === id);
      if (wf) await this.plugin.views().runWorkflow(wf);
      else new Notice(`Unknown workflow: ${id}`);
      return;
    }

    // kind: "action" — dispatch to the matching behavior.
    const outcome = await dispatchSlashAction(cmd.action, {
      actions: this.plugin.commandActions(),
      view: this.deps.view,
    });
    if (outcome === "unknown") new Notice(`Unknown command: /${cmd.name}`);
  }
}
