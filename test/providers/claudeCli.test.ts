import { describe, it, expect } from "vitest";
import { ClaudeCliProvider } from "../../src/providers/claudeCli";
import type { ClaudeCliRuntime } from "../../src/cli/runtime";

function runtime(overrides: Partial<ClaudeCliRuntime>): ClaudeCliRuntime {
  return {
    findClaude: async () => ({ executable: "/usr/local/bin/claude", version: "2.1.257" }),
    authStatus: async () => ({ loggedIn: true, method: "claude.ai" }),
    writeSystemPromptFile: async () => "/tmp/p.md",
    removeFile: async () => undefined,
    spawn: () => { throw new Error("not in this test"); },
    ...overrides,
  };
}

describe("ClaudeCliProvider", () => {
  it("has no credentials until refreshed, then reports the binary and login", async () => {
    const p = new ClaudeCliProvider(runtime({}));
    expect(p.hasCredentials()).toBe(false);
    const status = await p.refresh();
    expect(status).toEqual({ ok: true, detail: "Claude Code 2.1.257 · signed in via claude.ai · /usr/local/bin/claude" });
    expect(p.hasCredentials()).toBe(true);
    expect(p.executable()).toBe("/usr/local/bin/claude");
  });
  it("reports a missing binary", async () => {
    const p = new ClaudeCliProvider(runtime({ findClaude: async () => null }));
    expect(await p.refresh()).toEqual({ ok: false, detail: "Claude Code not found. Install it, then run `claude auth login`." });
    expect(p.hasCredentials()).toBe(false);
  });
  it("reports a signed-out binary", async () => {
    const p = new ClaudeCliProvider(runtime({ authStatus: async () => ({ loggedIn: false, method: "" }) }));
    expect(await p.refresh()).toEqual({ ok: false, detail: "Claude Code is not signed in. Run `claude auth login` in a terminal." });
    expect(p.hasCredentials()).toBe(false);
  });
  it("is unavailable without a runtime (mobile)", async () => {
    const p = new ClaudeCliProvider(null);
    expect(p.available()).toBe(false);
    expect(await p.test()).toEqual({ ok: false, detail: "Claude Code runs on desktop only." });
  });
  it("never streams: the turn runner owns the process", async () => {
    const p = new ClaudeCliProvider(runtime({}));
    await expect(p.complete({ system: "", messages: [], model: "m", maxTokens: 1 })).rejects.toThrow(/turn runner/);
  });
});
