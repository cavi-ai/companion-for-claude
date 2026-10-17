import type { ChatMessage } from "../types";
import type { ChatTurnMode, ChatTurnReceipt } from "../conversations/store";
import type { AgentTurnResult } from "../agent/loop";
import type { StartTurnInput } from "./turnService";

export interface CliSignIn {
  label: string;
  signInHint: string;
  available(): boolean;
  refresh(): Promise<unknown>;
}

interface ProviderLike {
  id: string;
  hasCredentials(): boolean;
}

export interface PreflightDeps<P extends ProviderLike> {
  backend: string;
  chatProvider(): { provider: P; model: string };
  chatCapabilities(): { cli: boolean; local: boolean };
  anthropicHasCredentials(): boolean;
  cliSignIn(): CliSignIn | null;
}

export type Preflight<P> =
  | { ok: true; provider: P; model: string; caps: { cli: boolean; local: boolean }; reprobed: boolean }
  | { ok: false; notice: string };

const CLI_BACKENDS = ["claude-cli", "codex-cli", "opencode-cli"];

/** Decides whether a send may start: the CLI sign-in gate (re-probing a stale cache once) and the provider credential gate. */
export async function preflightTurn<P extends ProviderLike>(deps: PreflightDeps<P>): Promise<Preflight<P>> {
  const { backend } = deps;
  let { provider, model } = deps.chatProvider();
  let caps = deps.chatCapabilities();
  let reprobed = false;
  if (CLI_BACKENDS.includes(backend) && !caps.cli && !deps.anthropicHasCredentials()) {
    const signIn = deps.cliSignIn();
    const label = signIn?.label ?? "This backend";
    if (signIn?.available()) {
      await signIn.refresh();
      caps = deps.chatCapabilities();
      if (caps.cli) {
        ({ provider, model } = deps.chatProvider());
        reprobed = true;
      }
    }
    if (!caps.cli) {
      return { ok: false, notice: signIn?.available() ? `${label} is not signed in — ${signIn.signInHint}, or add an API key in Companion settings.` : `${label} runs on desktop only. Add an API key to chat here.` };
    }
  }
  if (!provider.hasCredentials() && backend !== "auto") {
    const notice =
      provider.id === "ollama"
        ? "Start Ollama (`ollama serve`) or set the host in settings."
        : provider.id === "openai-compat"
          ? "Set the endpoint host and model in Companion settings → Local models."
          : "Add your Anthropic credential in Claude Companion settings first.";
    return { ok: false, notice };
  }
  return { ok: true, provider, model, caps, reprobed };
}

export interface TurnStartInput {
  conversationId: string | null;
  messages: ChatMessage[];
  previousTurn: ChatTurnReceipt | undefined;
  user: { content: string; display?: string };
  backend: string;
  model: string;
  mode: ChatTurnMode;
  continuationDepth: number;
  regenerate?: boolean;
}

export type BeginTurn = (
  conversationId: string | null,
  messages: ChatMessage[],
  input: { backend: string; model: string; mode: ChatTurnMode; continuationDepth?: number; regenerating?: boolean },
) => Promise<{ conversationId: string; turnId: string }>;

export type TurnStart =
  | { ok: true; turn: { conversationId: string; turnId: string }; messages: ChatMessage[]; turnMessages: ChatMessage[]; regenerating: boolean }
  | { ok: false; notice: string };

/** Prepares the turn's messages and begins it durably; a failed begin leaves the input untouched. */
export async function startTurn(begin: BeginTurn, input: TurnStartInput): Promise<TurnStart> {
  const { previousTurn, user } = input;
  const regenerating = !!input.regenerate && input.messages.at(-1)?.role === "assistant" && input.messages.at(-2)?.role === "user";
  const history = input.regenerate ? input.messages.slice(0, regenerating ? -2 : input.messages.at(-1)?.role === "user" ? -1 : input.messages.length) : input.messages;
  // A capped turn's partial work stays in context so the continuation sees what was done.
  const base =
    previousTurn && !previousTurn.regenerating && previousTurn.state !== "running" && previousTurn.state !== "capped"
      ? history.map((message, index) => (index >= previousTurn.userMessageIndex ? { ...message, contextExcluded: true } : message))
      : history;
  const messages: ChatMessage[] = [...base, { role: "user", content: user.content, ...(user.display !== undefined ? { display: user.display } : {}) }];
  // Snapshot now: the view may switch conversations while the turn is in flight.
  const turnMessages = [...messages];
  try {
    const turn = await begin(input.conversationId, messages, {
      backend: input.backend,
      model: input.model,
      mode: input.mode,
      ...(input.continuationDepth > 0 ? { continuationDepth: input.continuationDepth } : {}),
      ...(regenerating ? { regenerating: true } : {}),
    });
    return { ok: true, turn, messages, turnMessages, regenerating };
  } catch (error) {
    return { ok: false, notice: `Couldn't save this request, so it was not started: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface TurnPersistence {
  completeTurn(conversationId: string, turnId: string, messages: ChatMessage[]): Promise<void>;
  capTurn(conversationId: string, turnId: string, messages: ChatMessage[], handoff?: string): Promise<void>;
  interruptTurn(conversationId: string, turnId: string, messages: ChatMessage[], error?: string): Promise<void>;
}

/** The message list a turn should persist as: `base` plus the assistant reply, when one was produced. */
export function appendAssistantMessage(base: ChatMessage[], result: AgentTurnResult): ChatMessage[] {
  const full = result.text.trim();
  if (!full) return base;
  return [...base, { role: "assistant", content: result.text, ...(result.trace.length > 0 ? { toolTrace: result.trace } : {}) }];
}

export function turnPersistence(
  store: TurnPersistence,
  turn: { conversationId: string; turnId: string },
  turnMessages: ChatMessage[],
): Pick<StartTurnInput, "completeTurn" | "capTurn" | "interruptTurn"> {
  return {
    completeTurn: (result) => store.completeTurn(turn.conversationId, turn.turnId, appendAssistantMessage(turnMessages, result)),
    capTurn: (result) => store.capTurn(turn.conversationId, turn.turnId, appendAssistantMessage(turnMessages, result), result.handoff),
    interruptTurn: (result, error) => store.interruptTurn(turn.conversationId, turn.turnId, appendAssistantMessage(turnMessages, result), error?.message ?? "Interrupted"),
  };
}
