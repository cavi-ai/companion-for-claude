import { Notice, TFile, type App } from "obsidian";
import type { ChatViewHost } from "./hosts";
import type { ChatSession } from "./chatSession";
import { providerTurnRunner, type AgentTurnDeps, type AgentTurnHandlers, type AgentTurnResult, type AgentTurnRunner } from "../../agent/loop";
import { toAnthropicTools, executeTool, PROPOSE_EDIT_TOOL, truncateResult } from "../../agent/tools";
import { toolAccess } from "../../agent/toolAccess";
import { parseExternalToolName } from "../../mcp/external";
import { WriteConfirmModal } from "../WriteConfirmModal";
import { planEdits, parseProposedEdits } from "../../edit/diff";
import { reviewAndApply } from "../../edit/reviewAndApply";
import type { ApiMessage, CompletionRequest, Provider, ToolResultBlock, ToolUseBlock } from "../../providers/types";
import { transcriptText, type Conversation } from "../../conversations/store";
import { shapeRequest } from "../../claude/chatControls";
import { streamAttempt } from "../../providers/chatTurn";

export type TurnRunnersHost = Pick<
  ChatViewHost,
  | "agentTools" | "callExternalMcp" | "cliTurnRunner" | "composeSystemPrompt" | "conversations"
  | "externalMcpTools" | "interruptCliTurn" | "router" | "settings"
>;

export interface TurnRunnersDeps {
  /** The per-turn model and max-output overrides set by the running prompt template or flow. */
  turnOverrides(): { model: string | null; maxTokens: number | null };
  resumeCliSessionId(): string | null;
  /** The conversation this view shows. */
  conversationId(): string | null;
  onWriteGrant(): void;
  renderRecoverableEdit(conversation: Conversation): void;
  removeEditRecovery(): void;
}

/** Runs one attempt of a chat turn (provider stream, agent loop, or CLI runner) and the agent's tool calls; it never touches the DOM. */
export class TurnRunners {
  constructor(
    private app: App,
    private plugin: TurnRunnersHost,
    private chat: ChatSession,
    private deps: TurnRunnersDeps,
  ) {}

  /**
   * Build one streaming attempt on a backend; it emits through `handlers`, never
   * the DOM, so the view (attached or not) renders from the ChatTurnService
   * event stream.
   */
  streamTurn(
    target: "claude" | "local",
    apiMessages: ApiMessage[],
    handlers: AgentTurnHandlers,
    signal: AbortSignal,
    localOverride?: { provider: Provider; model: string },
  ): Promise<AgentTurnResult> {
    const router = this.plugin.router();
    const overrides = this.deps.turnOverrides();
    const controls = this.chat.controls;
    const onClaude = target === "claude";
    // "local" = the configured non-Claude chat backend (Ollama, or the custom
    // OpenAI-compatible endpoint when that's the chat backend) — or, for a
    // fallback attempt, whichever local backend the router found reachable.
    const local = onClaude ? undefined : localOverride ?? router.chatProvider();
    const provider = onClaude ? router.anthropic : local!.provider;
    const model = onClaude
      ? (overrides.model ?? controls.model)
      : local!.model;
    const shape = shapeRequest({ ...controls, model: onClaude ? model : controls.model }, overrides.maxTokens ?? this.plugin.settings.maxTokens);

    const request: CompletionRequest = {
      system: this.plugin.composeSystemPrompt({ project: this.chat.project, compact: provider.id === "device" }),
      messages: apiMessages,
      model,
      maxTokens: shape.maxTokens,
      signal,
    };
    if (onClaude && shape.temperature !== undefined) request.temperature = shape.temperature;
    if (onClaude && shape.thinking !== undefined) request.thinking = shape.thinking;
    if (onClaude && shape.thinkingDisplay !== undefined) request.thinkingDisplay = shape.thinkingDisplay;
    if (onClaude && shape.outputConfig !== undefined) request.outputConfig = shape.outputConfig;
    return streamAttempt(provider, request, handlers, signal);
  }

  /**
   * Run one agent-mode turn: Claude may call vault tools between streaming
   * passes (spec 2026-07-05). Always resolves; the caller (coreRun in run())
   * decides whether an error means fallback, a completed-with-notice answer,
   * or a hard failure.
   */
  async agentTurn(
    apiMessages: ApiMessage[],
    handlers: AgentTurnHandlers,
    signal: AbortSignal,
    conversationId?: string,
  ): Promise<AgentTurnResult> {
    const { provider, model: providerModel } = this.plugin.router().chatProvider();
    const overrides = this.deps.turnOverrides();
    const shape = shapeRequest(this.chat.controls, overrides.maxTokens ?? this.plugin.settings.maxTokens);
    const run = this.chat.mode.run;
    const externalTools = run === "chat" ? await this.plugin.externalMcpTools().catch(() => []) : [];
    if (signal.aborted) return { text: "", trace: [], aborted: true };
    const vaultDefs = this.plugin.agentTools().definitions();
    const access = toolAccess(run, vaultDefs);

    const request: CompletionRequest = {
      system: this.plugin.composeSystemPrompt({ agent: true, plan: run === "plan", project: this.chat.project }),
      messages: apiMessages,
      model: overrides.model ?? providerModel,
      maxTokens: shape.maxTokens,
      signal,
      tools: access.offered([...toAnthropicTools(vaultDefs), PROPOSE_EDIT_TOOL, ...externalTools]),
    };
    if (shape.temperature !== undefined) request.temperature = shape.temperature;
    if (shape.thinking !== undefined) request.thinking = shape.thinking;
    if (shape.thinkingDisplay !== undefined) request.thinkingDisplay = shape.thinkingDisplay;
    if (shape.outputConfig !== undefined) request.outputConfig = shape.outputConfig;

    const deps: AgentTurnDeps = {
      stream: (req, h) => provider.stream(req, h),
      execute: (block, sig) =>
        parseExternalToolName(block.name) && access.decide(block.name) === "run"
          ? this.executeExternalMcp(block, sig)
          : executeTool(
              {
                access,
                unavailable: (name) => this.plugin.agentTools().unavailable(name),
                ...(sig ? { signal: sig } : {}),
                call: (name, args) => this.plugin.agentTools().call(name, args),
                confirmWrite: (b) => this.confirmAgentWrite(b),
                proposeEdit: (b) => this.proposeAgentEdit(b, conversationId, signal),
              },
              block,
            ),
      maxIterations: this.plugin.settings.agentMaxIterations,
      signal,
    };

    let runner: AgentTurnRunner;
    try {
      runner = await this.turnRunnerFor(deps, request, signal, conversationId);
    } catch (error) {
      return { text: "", trace: [], error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (signal.aborted) return { text: "", trace: [], aborted: true };
    return runner.run(request, handlers);
  }

  /** The CLI runs the turn when the backend is Claude Code; otherwise today's provider loop does. */
  private async turnRunnerFor(deps: AgentTurnDeps, request: CompletionRequest, signal?: AbortSignal, turnConversationId?: string): Promise<AgentTurnRunner> {
    const caps = this.plugin.router().chatCapabilities();
    if (!caps.cli) return providerTurnRunner(deps);
    const conversationId = turnConversationId ?? this.chat.turn.currentTurn?.conversationId ?? this.plugin.conversations().activeId();
    const resumeSessionId = this.deps.resumeCliSessionId();
    signal?.addEventListener("abort", () => this.plugin.interruptCliTurn(conversationId), { once: true });
    return this.plugin.cliTurnRunner({
      conversationId,
      run: this.chat.mode.run,
      model: request.model,
      deps: { confirmWrite: async (b) => (await this.confirmAgentWrite(b)) && !signal?.aborted, proposeEdit: (b) => this.proposeAgentEdit(b, conversationId, signal) },
      transcript: resumeSessionId ? "" : transcriptText(this.chat.messages.slice(0, -1)),
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
  }

  /**
   * Handle a propose_note_edit call: plan against the current note, let the
   * user review per hunk inline or in the DiffModal, apply the accepted subset
   * atomically, and report the true outcome back to the model. Throws are
   * mapped to is_error tool_results by the executor (model self-corrects).
   */
  private async proposeAgentEdit(block: ToolUseBlock, conversationId?: string, signal?: AbortSignal): Promise<string> {
    const input = block.input;
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) throw new Error("propose_note_edit requires a 'path'.");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
    const edits = parseProposedEdits(input.edits);
    const description = typeof input.description === "string" ? input.description : undefined;

    const content = await this.app.vault.cachedRead(file);
    const plan = planEdits(content, edits);
    if (signal?.aborted) return "Turn stopped before the edit review opened.";
    const id = conversationId ?? this.chat.turn.currentTurn?.conversationId ?? this.deps.conversationId();
    if (!id) throw new Error("Conversation not found for edit recovery.");
    await this.plugin.conversations().saveEditProposal(id, { path, edits, ...(description ? { description } : {}) });
    return this.applyReviewedEdit(id, file, plan, description, signal);
  }

  private async applyReviewedEdit(conversationId: string, file: TFile, plan: ReturnType<typeof planEdits>, description?: string, signal?: AbortSignal): Promise<string> {
    const result = await reviewAndApply(this.app, file, plan, description, { inlineEnabled: this.plugin.settings.inlineDiffEnabled, ...(signal ? { signal } : {}) });
    if (signal?.aborted) return "Turn stopped. The proposed edit is saved for later review.";
    if (result.cancelled) {
      const conversation = this.plugin.conversations().list().find((entry) => entry.id === conversationId);
      if (conversation && this.deps.conversationId() === conversationId) this.deps.renderRecoverableEdit(conversation);
      return "User rejected the proposed edit. It is saved for later review.";
    }

    const { applied, total } = result;
    if (applied === total) {
      await this.plugin.conversations().clearEditProposal(conversationId).catch((error: unknown) => console.error("[Claude Companion] could not clear applied edit recovery record", error));
      if (this.deps.conversationId() === conversationId) this.deps.removeEditRecovery();
    } else {
      await this.plugin.conversations().saveEditProposal(conversationId, { path: file.path, edits: result.remaining, ...(description ? { description } : {}) }).catch((error: unknown) => console.error("[Claude Companion] could not retain rejected edit recovery record", error));
    }
    return applied === total
      ? `Applied all ${applied} edit${applied === 1 ? "" : "s"} to ${file.path}.`
      : `Applied ${applied} of ${total} edits to ${file.path} (the user rejected the rest).`;
  }

  async discardLastProposedEdit(conversation: Conversation): Promise<void> {
    await this.plugin.conversations().clearEditProposal(conversation.id).catch((error: unknown) => console.error("[Claude Companion] could not discard edit recovery record", error));
  }

  async reviewLastProposedEdit(conversation: Conversation): Promise<void> {
    const proposal = this.plugin.conversations().list().find((entry) => entry.id === conversation.id)?.lastEditProposal;
    if (!proposal) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(proposal.path);
      if (!(file instanceof TFile)) throw new Error(`Note not found: ${proposal.path}`);
      const plan = planEdits(await this.app.vault.cachedRead(file), proposal.edits);
      new Notice(await this.applyReviewedEdit(conversation.id, file, plan, proposal.description));
    } catch (error) {
      new Notice(`Could not reopen the proposed edit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Route an external MCP tool call: every call confirms first (external
   * servers can do anything), then dispatch; errors become is_error results
   * so the model adapts instead of the turn dying.
   */
  private async executeExternalMcp(block: ToolUseBlock, signal?: AbortSignal): Promise<ToolResultBlock> {
    const result = (content: string, isError?: boolean): ToolResultBlock => ({
      type: "tool_result",
      tool_use_id: block.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    if (block.parseError) return result(block.parseError, true);
    // Stop was pressed while a prior tool was running — don't fire another call.
    if (signal?.aborted) return result("Turn stopped before this tool ran.", true);
    if (!(await this.confirmAgentWrite(block))) return result("User declined.", true);
    if (signal?.aborted) return result("Turn stopped before this tool ran.", true);
    try {
      return result(truncateResult(await this.plugin.callExternalMcp(block.name, block.input)));
    } catch (err) {
      return result(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** Ask the user before an agent write tool runs; honors "allow for this session". */
  private confirmAgentWrite(block: ToolUseBlock): Promise<boolean> {
    if (this.chat.writeGrant) return Promise.resolve(true);
    return new Promise((resolve) => {
      new WriteConfirmModal(this.app, block, (choice) => {
        if (choice === "always") {
          this.chat.writeGrant = true;
          this.deps.onWriteGrant();
        }
        resolve(choice !== "deny");
      }).open();
    });
  }
}
