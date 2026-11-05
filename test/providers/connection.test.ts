import { describe, expect, it, vi } from "vitest";
import { ConnectionController } from "../../src/providers/connection";
import { DEFAULT_SETTINGS } from "../../src/types";
import { secretIdFor } from "../../src/secrets/store";

function rig() {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: "claude-cli" as const };
  const saved = new Map<string, string>();
  const test = vi.fn(async () => ({ ok: true, detail: "Connected" }));
  const save = vi.fn(async () => undefined);
  const controller = new ConnectionController({ settings: () => settings, save, test,
    store: { available: () => true, get: (id) => saved.get(id) ?? null, set: (id, value) => { saved.set(id, value); return true; } },
  });
  return { controller, settings, saved, test, save };
}

describe("connection transaction", () => {
  it("validates, securely stores and selects the same API connection", async () => {
    const r = rig();
    expect((await r.controller.connect({ backend: "claude", apiKey: "audit-key" })).ok).toBe(true);
    expect(r.test.mock.calls[0]![0]).toMatchObject({ chatBackend: "claude", authMode: "apiKey", apiKey: "audit-key" });
    expect(r.settings.chatBackend).toBe("claude");
    expect(r.saved.get(secretIdFor("apiKey"))).toBe("audit-key");
  });
  it("joins repeated submissions and restores usable state after a thrown transport error", async () => {
    const r = rig();
    r.test.mockRejectedValueOnce(new Error("Transport failed"));
    const first = r.controller.connect({ backend: "claude", apiKey: "audit-key" });
    const second = r.controller.connect({ backend: "claude", apiKey: "audit-key" });
    expect(await first).toMatchObject({ ok: false, detail: "Transport failed" });
    expect(await second).toMatchObject({ ok: false });
    expect(r.test).toHaveBeenCalledTimes(1);
    expect(r.settings.chatBackend).toBe("claude-cli");
    expect(r.save).not.toHaveBeenCalled();
    expect((await r.controller.connect({ backend: "claude", apiKey: "audit-key" })).ok).toBe(true);
  });
  it("does not persist a credential rejected by secret storage", async () => {
    const r = rig();
    const controller = new ConnectionController({ settings: () => r.settings, save: r.save, test: r.test,
      store: { available: () => true, get: () => null, set: () => false } });
    expect(await controller.connect({ backend: "claude", apiKey: "audit-key" })).toMatchObject({ ok: false });
    expect(r.settings.apiKey).toBe("");
    expect(r.save).not.toHaveBeenCalled();
  });
  it("restores a previous stored key if the backend partially writes and refuses the replacement", async () => {
    const r = rig();
    let stored = "previous-key";
    let writes = 0;
    const controller = new ConnectionController({ settings: () => r.settings, save: r.save, test: r.test,
      store: { available: () => true, get: () => stored, set: (_id, value) => { stored = value; return ++writes > 1; } } });
    expect((await controller.connect({ backend: "claude", apiKey: "replacement-key" })).ok).toBe(false);
    expect(stored).toBe("previous-key");
    expect(r.save).not.toHaveBeenCalled();
  });
  it("never reports success for a different connection while another is being checked", async () => {
    const r = rig();
    let release!: () => void;
    r.test.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, detail: "Connected" }); }));
    const pending = r.controller.connect({ backend: "claude", apiKey: "audit-key" });
    const other = r.controller.connect({ backend: "codex-cli" });
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(await other).toMatchObject({ ok: false });
    expect(r.settings.chatBackend).toBe("claude");
  });
  it("restores the previous connection on a settings write failure", async () => {
    const r = rig();
    r.save.mockRejectedValueOnce(new Error("Disk full"));
    expect(await r.controller.connect({ backend: "claude", apiKey: "audit-key" })).toMatchObject({ ok: false });
    expect(r.settings.chatBackend).toBe("claude-cli");
    expect(r.settings.apiKey).toBe("");
    expect(r.saved.get(secretIdFor("apiKey")) ?? "").toBe("");
  });
  it.each(["baseUrl", "oauthToken"] as const)("rejects a stale check when %s changes while it runs", async (key) => {
    const r = rig();
    r.settings.authMode = "oauthToken";
    let release!: () => void;
    r.test.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, detail: "Connected" }); }));
    const pending = r.controller.connect({ backend: "claude" });
    r.settings[key] = "changed-during-check";
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(r.settings[key]).toBe("changed-during-check");
    expect(r.settings.chatBackend).toBe("claude-cli");
    expect(r.save).not.toHaveBeenCalled();
  });
  it("preserves unrelated preference edits made during a connection check", async () => {
    const r = rig();
    let release!: () => void;
    r.test.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, detail: "Connected" }); }));
    const pending = r.controller.connect({ backend: "claude", apiKey: "audit-key" });
    r.settings.notifyOnTurnComplete = !r.settings.notifyOnTurnComplete;
    const preference = r.settings.notifyOnTurnComplete;
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(r.settings.notifyOnTurnComplete).toBe(preference);
  });
});
