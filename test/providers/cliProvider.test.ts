import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { CliProvider } from "../../src/providers/cliProvider";
import { claudeBackend } from "../../src/cli/backends/claude";
import { codexBackend } from "../../src/cli/backends/codex";
import { opencodeBackend } from "../../src/cli/backends/opencode";
import type { CliRuntime } from "../../src/cli/runtime";
import type { CliBackend } from "../../src/cli/backends/types";
import type { CompletionRequest } from "../../src/providers/types";

class FakeChild extends EventEmitter {
  stdin = { write: () => true, end: () => undefined };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal?: string): boolean { this.signals.push(signal ?? "SIGTERM"); return true; }
}

const req: CompletionRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], model: "m", maxTokens: 10 };
const flush = () => new Promise<void>((r) => setImmediate(r));

function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawned: { exe: string; cwd: string }[] = [];
  const spawn = ((exe: string, _argv: string[], cwd: string) => {
    const c = new FakeChild();
    children.push(c);
    spawned.push({ exe, cwd });
    return c;
  }) as unknown as CliRuntime["spawn"];
  return { children, spawned, spawn };
}

function reply(c: FakeChild, backend: CliBackend, t: string): void {
  if (backend.processModel === "persistent") {
    c.stdout.emit("data", Buffer.from(`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${t}"}}}\n{"type":"result","subtype":"success","result":"${t}","session_id":"s","is_error":false}\n`));
  } else if (backend.id === "codex-cli") {
    c.stdout.emit("data", Buffer.from(`{"type":"item.completed","item":{"type":"agent_message","text":"${t}"}}\n{"type":"turn.completed","usage":{}}\n`));
  } else {
    c.stdout.emit("data", Buffer.from(`{"type":"text","part":{"text":"${t}"}}\n{"type":"step_finish","part":{"reason":"stop"}}\n`));
  }
}

function runtime(overrides: Partial<CliRuntime>): CliRuntime {
  return {
    find: async () => ({ executable: "/usr/local/bin/x", version: "1.2.3" }),
    probe: async () => ({ loggedIn: true, method: "x.ai" }),
    writeSystemPromptFile: async () => "/tmp/p.md",
    removeFile: async () => undefined,
    spawn: () => { throw new Error("not in this test"); },
    ...overrides,
  };
}

describe.each([
  ["Claude Code", claudeBackend],
  ["Codex", codexBackend],
  ["OpenCode", opencodeBackend],
] as [string, CliBackend][])("CliProvider over %s", (_label, backend) => {
  it("has no credentials until refreshed, then reports the binary and login, naming the backend", async () => {
    const p = new CliProvider(backend, runtime({}));
    expect(p.id).toBe(backend.id);
    expect(p.label).toBe(backend.label);
    expect(p.hasCredentials()).toBe(false);
    const status = await p.refresh();
    expect(status).toEqual({ ok: true, detail: `${backend.label} 1.2.3 · signed in via x.ai · /usr/local/bin/x` });
    expect(p.hasCredentials()).toBe(true);
    expect(p.executable()).toBe("/usr/local/bin/x");
  });

  it("reports a missing binary, naming the backend and its sign-in command", async () => {
    const p = new CliProvider(backend, runtime({ find: async () => null }));
    const status = await p.refresh();
    expect(status.ok).toBe(false);
    expect(status.detail).toContain(backend.label);
    expect(status.detail).toContain(backend.signInHint);
    expect(p.hasCredentials()).toBe(false);
  });

  it("reports a signed-out binary, naming the backend", async () => {
    const p = new CliProvider(backend, runtime({ probe: async () => ({ loggedIn: false, method: "" }) }));
    const status = await p.refresh();
    expect(status.ok).toBe(false);
    expect(status.detail).toContain(backend.label);
    expect(p.hasCredentials()).toBe(false);
  });

  it("is unavailable without a runtime (mobile)", async () => {
    const p = new CliProvider(backend, null);
    expect(p.available()).toBe(false);
    const status = await p.test();
    expect(status.ok).toBe(false);
    expect(status.detail).toBe(`${backend.label} runs on desktop only.`);
  });

  it("complete() returns the CLI text through the runtime", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(backend, runtime({ spawn: t.spawn }), () => "/vault");
    const done = p.complete(req);
    await flush();
    expect(t.spawned[0]!.exe).toBe("/usr/local/bin/x");
    expect(t.spawned[0]!.cwd).toBe("/vault");
    reply(t.children[0]!, backend, "pong");
    await expect(done).resolves.toBe("pong");
    expect(p.hasCredentials()).toBe(true);
  });

  it("refreshes once when unprobed, then runs", async () => {
    const t = fakeSpawn();
    const find = vi.fn(async () => ({ executable: "/usr/local/bin/x", version: "1" }));
    const p = new CliProvider(backend, runtime({ spawn: t.spawn, find }), () => "/vault");
    const done = p.complete(req);
    await flush();
    reply(t.children[0]!, backend, "ok");
    await done;
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("rejects with the not-signed-in message and never spawns when signed out", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(backend, runtime({ spawn: t.spawn, probe: async () => ({ loggedIn: false, method: "" }) }), () => "/vault");
    await expect(p.complete(req)).rejects.toThrow(`${backend.label} is not signed in.`);
    expect(t.children).toHaveLength(0);
  });

  it("rejects desktop-only when there is no cwd", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(backend, runtime({ spawn: t.spawn }), () => null);
    await expect(p.complete(req)).rejects.toThrow("runs on desktop only");
    expect(t.children).toHaveLength(0);
  });

  it("stream() delivers deltas then onDone", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(backend, runtime({ spawn: t.spawn }), () => "/vault");
    const deltas: string[] = [];
    let full = "";
    const done = p.stream(req, { onText: (d) => deltas.push(d), onDone: (f) => { full = f; } });
    await flush();
    reply(t.children[0]!, backend, "pong");
    await done;
    expect(deltas.join("")).toBe("pong");
    expect(full).toBe("pong");
  });

  it("stream() failure goes to onError and never throws", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(backend, runtime({ spawn: t.spawn }), () => "/vault");
    let error: Error | undefined;
    const done = p.stream(req, { onText: () => undefined, onError: (e) => { error = e; } });
    await flush();
    t.children[0]!.emit("exit", 3);
    await done;
    expect(error?.message).toContain(backend.label);
  });

  it("cancelAll() kills an in-flight child", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(backend, runtime({ spawn: t.spawn }), () => "/vault");
    const done = p.complete(req);
    done.catch(() => undefined);
    await flush();
    p.cancelAll();
    expect(t.children[0]!.signals).toEqual(["SIGTERM"]);
    t.children[0]!.emit("exit", null);
    await expect(done).rejects.toThrow();
  });
});

describe("CliProvider abort", () => {
  it("aborting one run kills only the child that run spawned", async () => {
    const t = fakeSpawn();
    const p = new CliProvider(codexBackend, runtime({ spawn: t.spawn }), () => "/vault");
    const controller = new AbortController();
    const first = p.complete({ ...req, signal: controller.signal });
    first.catch(() => undefined);
    const second = p.complete(req);
    await flush();
    expect(t.children).toHaveLength(2);
    controller.abort();
    expect(t.children[0]!.signals).toEqual(["SIGTERM"]);
    expect(t.children[1]!.signals).toEqual([]);
    await expect(first).rejects.toThrow();
    reply(t.children[1]!, codexBackend, "ok");
    t.children[1]!.emit("exit", 0);
    await expect(second).resolves.toBe("ok");
  });
});
