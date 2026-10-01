import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";
import { runCliCompletion, type CliCompletionDeps } from "../../src/cli/completion";
import { claudeBackend } from "../../src/cli/backends/claude";
import { codexBackend } from "../../src/cli/backends/codex";
import type { CompletionRequest } from "../../src/providers/types";

class FakeStdin {
  writes: string[] = [];
  ended = false;
  write(chunk: string): boolean { this.writes.push(chunk); return true; }
  end(): void { this.ended = true; }
}
class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal?: string): boolean { this.signals.push(signal ?? "SIGTERM"); return true; }
}

const req: CompletionRequest = { system: "sys", messages: [{ role: "user", content: "hello" }], model: "m", maxTokens: 10 };
const text = (t: string) => `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${t}"}}}\n`;
const result = (t: string, isError = false) => `{"type":"result","subtype":"success","result":"${t}","session_id":"s","is_error":${isError}}\n`;
const feed = (c: FakeChild, s: string) => c.stdout.emit("data", Buffer.from(s));

function setup(backend = claudeBackend, extra: Partial<CliCompletionDeps> = {}) {
  const children: FakeChild[] = [];
  const argvs: string[][] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const deps: CliCompletionDeps = {
    backend,
    spawn: (argv) => { argvs.push(argv); const c = new FakeChild(); children.push(c); return c; },
    writeSystemPromptFile: async (t) => { written.push(t); return "/tmp/prompt.md"; },
    removeFile: async (p) => { removed.push(p); },
    ...extra,
  };
  return { deps, children, argvs, written, removed };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => vi.useRealTimers());

describe("runCliCompletion", () => {
  it("claude: returns text, writes one stdin line then ends, removes the prompt file", async () => {
    const t = setup();
    const p = runCliCompletion(t.deps, req, "/v");
    await tick();
    const c = t.children[0]!;
    expect(c.stdin.writes).toHaveLength(1);
    expect(c.stdin.ended).toBe(true);
    const argv = t.argvs[0]!;
    expect(argv[argv.indexOf("--system-prompt-file") + 1]).toBe("/tmp/prompt.md");
    expect(t.written).toEqual(["sys"]);
    feed(c, text("po") + text("ng") + result("pong"));
    await expect(p).resolves.toBe("pong");
    expect(t.removed).toEqual(["/tmp/prompt.md"]);
  });

  it("streams deltas to onText", async () => {
    const t = setup();
    const got: string[] = [];
    const p = runCliCompletion(t.deps, req, "/v", (d) => got.push(d));
    await tick();
    feed(t.children[0]!, text("a") + text("b") + result("ab"));
    await p;
    expect(got).toEqual(["a", "b"]);
  });

  it("resolves the result text when no deltas arrived", async () => {
    const t = setup();
    const p = runCliCompletion(t.deps, req, "/v");
    await tick();
    feed(t.children[0]!, result("only"));
    await expect(p).resolves.toBe("only");
  });

  it("rejects with the CLI message on is_error and still removes the file", async () => {
    const t = setup();
    const p = runCliCompletion(t.deps, req, "/v");
    await tick();
    feed(t.children[0]!, result("model not found", true));
    await expect(p).rejects.toThrow("model not found");
    expect(t.removed).toEqual(["/tmp/prompt.md"]);
  });

  it("rejects on nonzero exit with the stderr tail", async () => {
    const t = setup();
    const p = runCliCompletion(t.deps, req, "/v");
    await tick();
    t.children[0]!.stderr.emit("data", Buffer.from("boom"));
    t.children[0]!.emit("exit", 2);
    await expect(p).rejects.toThrow("Claude Code exited (code 2). boom");
  });

  it("rejects on a spawn error", async () => {
    const t = setup();
    const p = runCliCompletion(t.deps, req, "/v");
    await tick();
    t.children[0]!.emit("error", new Error("ENOENT"));
    await expect(p).rejects.toThrow("Claude Code failed to start: ENOENT");
  });

  it("never spawns when the signal is already aborted", async () => {
    const t = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(runCliCompletion(t.deps, { ...req, signal: ac.signal }, "/v")).rejects.toMatchObject({ name: "AbortError" });
    expect(t.children).toHaveLength(0);
  });

  it("abort mid-run sends SIGTERM then SIGKILL and rejects", async () => {
    vi.useFakeTimers();
    const t = setup();
    const ac = new AbortController();
    const p = runCliCompletion(t.deps, { ...req, signal: ac.signal }, "/v");
    const assertion = expect(p).rejects.toThrow("Cancelled");
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await assertion;
    expect(t.children[0]!.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("kills and rejects after idle silence", async () => {
    vi.useFakeTimers();
    const t = setup(claudeBackend, { idleAbortMs: 1000 });
    const p = runCliCompletion(t.deps, req, "/v");
    const assertion = expect(p).rejects.toThrow("Claude Code produced no output for 1 s.");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(t.children[0]!.signals[0]).toBe("SIGTERM");
  });

  it("codex per-turn: folds the prompt into argv and resolves accumulated text on exit 0", async () => {
    const t = setup(codexBackend);
    const p = runCliCompletion(t.deps, req, "/v");
    await tick();
    const c = t.children[0]!;
    expect(t.argvs[0]!.at(-1)).toBe("sys\n\nhello");
    expect(c.stdin.writes).toHaveLength(0);
    expect(c.stdin.ended).toBe(true);
    feed(c, '{"type":"item.completed","item":{"type":"agent_message","text":"hi there"}}\n');
    c.emit("exit", 0);
    await expect(p).resolves.toBe("hi there");
  });
});
