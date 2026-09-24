import { describe, it, expect } from "vitest";
import { CliProvider } from "../../src/providers/cliProvider";
import { claudeBackend } from "../../src/cli/backends/claude";
import { codexBackend } from "../../src/cli/backends/codex";
import { opencodeBackend } from "../../src/cli/backends/opencode";
import type { CliRuntime } from "../../src/cli/runtime";
import type { CliBackend } from "../../src/cli/backends/types";

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

  it("never streams: the turn runner owns the process", async () => {
    const p = new CliProvider(backend, runtime({}));
    await expect(p.complete({ system: "", messages: [], model: "m", maxTokens: 1 })).rejects.toThrow(/turn runner/);
    let error: Error | undefined;
    await p.stream({ system: "", messages: [], model: "m", maxTokens: 1 }, { onError: (e) => { error = e; } });
    expect(error?.message).toContain(backend.label);
  });
});
