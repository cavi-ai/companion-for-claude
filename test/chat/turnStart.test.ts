import { describe, expect, it, vi } from "vitest";
import { appendAssistantMessage, preflightTurn, startTurn, turnPersistence, type BeginTurn, type CliSignIn, type TurnStartInput } from "../../src/chat/turnStart";
import type { ChatMessage } from "../../src/types";
import type { ChatTurnReceipt } from "../../src/conversations/store";
import type { AgentTurnResult } from "../../src/agent/loop";

import { conversationFakes } from "../fakes/conversations";

const CLI = { cli: true, local: false };
const NOT_CLI = { cli: false, local: false };

function provider(id: string, hasCredentials: boolean) {
  return { id, hasCredentials: () => hasCredentials };
}

function cliGate(opts: { backend?: string; signedIn: boolean; refreshSignsIn?: boolean; available?: boolean; anthropic?: boolean }) {
  const state = { signedIn: opts.signedIn };
  const refresh = vi.fn(async () => {
    state.signedIn = opts.refreshSignsIn ?? false;
  });
  const signIn: CliSignIn = { label: "Claude Code", signInHint: "run `claude auth login`", available: () => opts.available ?? true, refresh };
  const deps = {
    backend: opts.backend ?? "claude-cli",
    chatProvider: () => ({ provider: provider(state.signedIn ? "claude-cli" : "anthropic", state.signedIn), model: "m" }),
    chatCapabilities: () => (state.signedIn ? CLI : NOT_CLI),
    anthropicHasCredentials: () => opts.anthropic ?? false,
    cliSignIn: () => signIn,
  };
  return { deps, refresh };
}

describe("preflightTurn", () => {
  it("re-probes once and proceeds when refresh signs the CLI in", async () => {
    const { deps, refresh } = cliGate({ signedIn: false, refreshSignsIn: true });
    const result = await preflightTurn(deps);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, reprobed: true, model: "m", caps: CLI });
    expect(result.ok && result.provider.id).toBe("claude-cli");
  });

  it.each(["claude-cli", "codex-cli", "opencode-cli"])("blocks a %s send with the not-signed-in notice when refresh does not flip, refreshing once", async (backend) => {
    const { deps, refresh } = cliGate({ backend, signedIn: false, refreshSignsIn: false });
    const result = await preflightTurn(deps);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, notice: "Claude Code is not signed in — run `claude auth login`, or add an API key in Companion settings." });
  });

  it("blocks with the desktop-only notice when sign-in is unavailable, never refreshing", async () => {
    const { deps, refresh } = cliGate({ signedIn: false, available: false });
    const result = await preflightTurn(deps);
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, notice: "Claude Code runs on desktop only. Add an API key to chat here." });
  });

  it("falls back to a generic label when the backend has no sign-in entry", async () => {
    const { deps } = cliGate({ signedIn: false });
    const result = await preflightTurn({ ...deps, cliSignIn: () => null });
    expect(result).toEqual({ ok: false, notice: "This backend runs on desktop only. Add an API key to chat here." });
  });

  it("proceeds without refreshing when the CLI is already signed in", async () => {
    const { deps, refresh } = cliGate({ signedIn: true });
    const result = await preflightTurn(deps);
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, reprobed: false });
  });

  it("proceeds without refreshing when Anthropic has credentials", async () => {
    const { deps, refresh } = cliGate({ signedIn: false, anthropic: true });
    const result = await preflightTurn({ ...deps, chatProvider: () => ({ provider: provider("anthropic", true), model: "m" }) });
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, reprobed: false });
  });

  it.each([
    ["ollama", "Start Ollama (`ollama serve`) or set the host in settings."],
    ["openai-compat", "Set the endpoint host and model in Companion settings → Local models."],
    ["anthropic", "Add your Anthropic credential in Claude Companion settings first."],
  ])("blocks a %s provider without credentials", async (id, notice) => {
    const result = await preflightTurn({
      backend: "local",
      chatProvider: () => ({ provider: provider(id, false), model: "m" }),
      chatCapabilities: () => NOT_CLI,
      anthropicHasCredentials: () => false,
      cliSignIn: () => null,
    });
    expect(result).toEqual({ ok: false, notice });
  });

  it("lets the auto backend proceed without credentials", async () => {
    const result = await preflightTurn({
      backend: "auto",
      chatProvider: () => ({ provider: provider("anthropic", false), model: "m" }),
      chatCapabilities: () => NOT_CLI,
      anthropicHasCredentials: () => false,
      cliSignIn: () => null,
    });
    expect(result).toMatchObject({ ok: true, reprobed: false });
  });
});

function receipt(state: ChatTurnReceipt["state"], userMessageIndex: number): ChatTurnReceipt {
  return { id: "t0", state, backend: "claude", model: "m", mode: "ask", userMessageIndex, createdAt: 1, updatedAt: 1 };
}

const HISTORY: ChatMessage[] = [
  { role: "user", content: "a" },
  { role: "assistant", content: "b" },
  { role: "user", content: "c" },
  { role: "assistant", content: "d" },
];

function input(overrides: Partial<TurnStartInput> = {}): TurnStartInput {
  return { conversationId: "c1", messages: HISTORY, previousTurn: undefined, user: { content: "next" }, backend: "claude", model: "m", mode: "ask", continuationDepth: 0, ...overrides };
}

const begun = { conversationId: "c1", turnId: "t1" };

describe("startTurn", () => {
  it("persists explicit note and captured-page references on the accepted question", async () => {
    const contextAttachments = { paths: [{ path: "A.md", kind: "note" as const }], pages: [{ url: "https://example.test/a", markdown: "Page A" }] };
    const fakes = conversationFakes();
    const result = await startTurn((...args) => fakes.conversations.beginTurn(...args), input({ user: { content: "Question A", contextAttachments } }));
    expect(result.ok && result.turnMessages.at(-1)).toMatchObject({ contextAttachments });
    expect(fakes.conversations.list()[0]?.messages.at(-1)).toMatchObject({ contextAttachments });
  });

  it("persists attachment references with the accepted user message", async () => {
    const media = [{ label: "Chart.png", path: "Chart.png", kind: "image" as const, mime: "image/png" }];
    const fakes = conversationFakes();
    const result = await startTurn((...args) => fakes.conversations.beginTurn(...args), input({ user: { content: "Review chart", media } }));
    expect(result.ok && result.turnMessages.at(-1)).toMatchObject({ media });
    expect(fakes.conversations.list()[0]?.messages.at(-1)).toMatchObject({ media });
  });

  it("interrupts a saved request when ownership changes during later preparation", async () => {
    const fakes = conversationFakes();
    let current = true;
    const result = await startTurn((...args) => fakes.conversations.beginTurn(...args), input({
      ownership: { current: () => current, interruptTurn: (...args) => fakes.conversations.interruptTurn(...args) },
    }));
    if (!result.ok) throw new Error("Expected durable start");
    current = false;
    await result.keepCurrent?.();
    expect(fakes.conversations.list()[0]?.activeTurn?.state).toBe("interrupted");
    expect(fakes.conversations.list()[0]?.messages.at(-1)?.content).toBe("next");
  });

  it.each([false, true])("keeps a saved request recoverable when its owner changes (regenerate: %s)", async (regenerate) => {
    const fakes = conversationFakes({ conversations: [{ id: "c1", title: "Earlier chat", createdAt: 1, updatedAt: 1, messages: HISTORY }] });
    let current = true;
    const begin: BeginTurn = async (...args) => {
      const turn = await fakes.conversations.beginTurn(...args);
      current = false;
      return turn;
    };
    const result = await startTurn(begin, input({
      regenerate,
      ownership: { current: () => current, interruptTurn: (...args) => fakes.conversations.interruptTurn(...args) },
    }));
    expect(result).toMatchObject({ ok: false, notice: expect.stringContaining("Resume it from history") });
    const saved = fakes.conversations.list()[0]!;
    expect(saved.activeTurn?.state).toBe("interrupted");
    expect(saved.messages.map((message) => message.content)).toEqual(regenerate ? ["a", "b", "c", "d"] : ["a", "b", "c", "d", "next"]);
  });

  it("accepts the saved request while its owner remains current", async () => {
    const fakes = conversationFakes();
    const result = await startTurn((...args) => fakes.conversations.beginTurn(...args), input({
      ownership: { current: () => true, interruptTurn: (...args) => fakes.conversations.interruptTurn(...args) },
    }));
    expect(result.ok).toBe(true);
    expect(fakes.conversations.list()[0]?.activeTurn?.state).toBe("running");
  });

  it("regenerates without sending the superseded answer or mutating the saved exchange", async () => {
    const begin = vi.fn(async () => begun);
    const result = await startTurn(begin, input({ regenerate: true, user: { content: "c" } }));
    expect(result.ok && result.messages).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
    expect(begin).toHaveBeenCalledWith("c1", expect.any(Array), { backend: "claude", model: "m", mode: "ask", regenerating: true });
    expect(HISTORY.at(-1)?.content).toBe("d");
  });

  it("keeps the retained answer in context on a follow-up after failed regeneration", async () => {
    const result = await startTurn(async () => begun, input({ previousTurn: { ...receipt("interrupted", 2), regenerating: true } }));
    expect(result.ok && result.messages.some((message) => message.contextExcluded)).toBe(false);
  });

  it("retries an unanswered prompt without duplicating it", async () => {
    const result = await startTurn(async () => begun, input({ messages: [{ role: "user", content: "q" }], regenerate: true, user: { content: "q" } }));
    expect(result.ok && result.messages).toEqual([{ role: "user", content: "q" }]);
    expect(result.ok && result.regenerating).toBe(false);
  });
  it.each(["interrupted", "failed"] as const)("marks context excluded from the %s turn's user message and leaves earlier messages alone", async (state) => {
    const begin = vi.fn(async () => begun);
    const result = await startTurn(begin, input({ previousTurn: receipt(state, 2) }));
    expect(result.ok && result.messages.map((m) => m.contextExcluded)).toEqual([undefined, undefined, true, true, undefined]);
  });

  it.each(["running", "capped"] as const)("marks nothing after a %s turn", async (state) => {
    const result = await startTurn(async () => begun, input({ previousTurn: receipt(state, 2) }));
    expect(result.ok && result.messages.some((m) => m.contextExcluded)).toBe(false);
  });

  it("adds display only when given", async () => {
    const plain = await startTurn(async () => begun, input());
    const labelled = await startTurn(async () => begun, input({ user: { content: "next", display: "Next" } }));
    expect(plain.ok && plain.messages[4]).toEqual({ role: "user", content: "next" });
    expect(plain.ok && "display" in plain.messages[4]!).toBe(false);
    expect(labelled.ok && labelled.messages[4]).toEqual({ role: "user", content: "next", display: "Next" });
  });

  it("returns a turn snapshot that later mutation of messages does not change", async () => {
    const result = await startTurn(async () => begun, input());
    if (!result.ok) throw new Error("expected ok");
    result.messages.push({ role: "assistant", content: "late" });
    expect(result.turnMessages).toHaveLength(5);
    expect(HISTORY).toHaveLength(4);
  });

  it("returns the begin ids and passes the messages and backend inputs", async () => {
    const begin = vi.fn(async () => begun);
    const result = await startTurn(begin, input({ mode: "plan", model: "m2" }));
    expect(result).toMatchObject({ ok: true, turn: begun });
    expect(begin).toHaveBeenCalledWith("c1", expect.any(Array), { backend: "claude", model: "m2", mode: "plan" });
    expect((begin.mock.calls[0] as unknown as [string, ChatMessage[]])[1]).toHaveLength(5);
  });

  it("passes continuationDepth only when above zero", async () => {
    const begin = vi.fn(async () => begun);
    await startTurn(begin, input({ continuationDepth: 2 }));
    expect(begin).toHaveBeenCalledWith("c1", expect.any(Array), { backend: "claude", model: "m", mode: "ask", continuationDepth: 2 });
  });

  it("fails with the save notice and leaves the input untouched when begin rejects", async () => {
    const messages = [...HISTORY];
    const result = await startTurn(async () => { throw new Error("disk full"); }, input({ messages, previousTurn: receipt("failed", 0) }));
    expect(result).toEqual({ ok: false, notice: "Couldn't save this request, so it was not started: disk full" });
    expect(messages).toEqual(HISTORY);
    expect(messages.some((m) => m.contextExcluded)).toBe(false);
  });

  it("stringifies a non-Error rejection", async () => {
    const result = await startTurn(async () => { throw "nope"; }, input());
    expect(result).toEqual({ ok: false, notice: "Couldn't save this request, so it was not started: nope" });
  });
});

function agentResult(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return { text: "answer", trace: [], ...overrides } as AgentTurnResult;
}

function store() {
  return { completeTurn: vi.fn(async () => undefined), capTurn: vi.fn(async () => undefined), interruptTurn: vi.fn(async () => undefined) };
}

describe("turnPersistence", () => {
  const base: ChatMessage[] = [{ role: "user", content: "q" }];
  const turn = { conversationId: "c1", turnId: "t1" };

  it("completes with the turn messages plus the assistant message", async () => {
    const s = store();
    await turnPersistence(s, turn, base).completeTurn(agentResult());
    expect(s.completeTurn).toHaveBeenCalledWith("c1", "t1", [...base, { role: "assistant", content: "answer" }]);
  });

  it("caps with the handoff forwarded", async () => {
    const s = store();
    await turnPersistence(s, turn, base).capTurn!(agentResult({ handoff: "pick up here" }));
    expect(s.capTurn).toHaveBeenCalledWith("c1", "t1", [...base, { role: "assistant", content: "answer" }], "pick up here");
  });

  it("interrupts with the error message, defaulting to Interrupted", async () => {
    const s = store();
    const hooks = turnPersistence(s, turn, base);
    await hooks.interruptTurn(agentResult(), new Error("boom"));
    await hooks.interruptTurn(agentResult());
    expect(s.interruptTurn).toHaveBeenNthCalledWith(1, "c1", "t1", [...base, { role: "assistant", content: "answer" }], "boom");
    expect(s.interruptTurn).toHaveBeenNthCalledWith(2, "c1", "t1", [...base, { role: "assistant", content: "answer" }], "Interrupted");
  });

  it("appends nothing when the result text is blank", async () => {
    const s = store();
    await turnPersistence(s, turn, base).completeTurn(agentResult({ text: "  \n" }));
    expect(s.completeTurn).toHaveBeenCalledWith("c1", "t1", base);
  });

  it("carries the tool trace onto the assistant message", () => {
    const trace = [{ name: "vault_search" }] as unknown as AgentTurnResult["trace"];
    expect(appendAssistantMessage(base, agentResult({ trace }))[1]).toEqual({ role: "assistant", content: "answer", toolTrace: trace });
  });
});

describe("media preflight", () => {
  const deps = (id: string) => ({ backend: id, chatProvider: () => ({ provider: provider(id, true), model: "m" }), chatCapabilities: () => ({ cli: id.endsWith("-cli"), local: id === "ollama" || id === "openai-compat" || id === "device" }), anthropicHasCredentials: () => true, cliSignIn: () => null });
  it.each(["openai-compat", "ollama", "device", "codex-cli", "opencode-cli"])("refuses image/PDF attachments on the text-only %s transport", async id => {
    const result = await preflightTurn({ ...deps(id), hasMedia: true });
    expect(result).toMatchObject({ ok: false, notice: expect.stringContaining("sends text only") });
    expect(await preflightTurn(deps(id))).toMatchObject({ ok: true });
  });
  it.each(["anthropic", "claude-cli"])("allows attachments through %s without changing providers", async id => {
    const result = await preflightTurn({ ...deps(id), hasMedia: true });
    expect(result.ok && result.provider.id).toBe(id);
  });
  it("requires Claude credentials for an attachment that cannot fall back locally", async () => {
    const result = await preflightTurn({ ...deps("anthropic"), backend: "auto", chatProvider: () => ({ provider: provider("anthropic", false), model: "m" }), hasMedia: true });
    expect(result).toMatchObject({ ok: false, notice: expect.stringContaining("credential") });
  });
});
