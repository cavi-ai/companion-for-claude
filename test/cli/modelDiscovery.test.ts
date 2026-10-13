import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCodexModels, parseOpenCodeModels } from "../../src/cli/modelDiscovery";
import type { CliChild } from "../../src/cli/session";

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: Record<string, unknown>[] = [];
  signals: string[] = [];
  stdin = { write: (s: string) => { this.sent.push(JSON.parse(s)); }, end: () => {} };
  kill(signal?: string): boolean { this.signals.push(signal ?? "SIGTERM"); return true; }
  reply(id: number, result: unknown): void { this.stdout.emit("data", Buffer.from(`${JSON.stringify({ id, result })}\n`)); }
}

afterEach(() => vi.useRealTimers());

describe("CLI model discovery", () => {
  it("parses OpenCode provider/model ids, keeping nested ids and removing noise and duplicates", () => {
    expect(parseOpenCodeModels("\u001b[32mollama/qwen3:8b\u001b[0m\nopenrouter/openai/gpt-sol\nollama/qwen3:8b\nLoading models…\n"))
      .toEqual([{ id: "ollama/qwen3:8b", label: "ollama/qwen3:8b" }, { id: "openrouter/openai/gpt-sol", label: "openrouter/openai/gpt-sol" }]);
  });

  it("initializes Codex before requesting models, follows pagination, and excludes hidden models", async () => {
    const child = new Child();
    const result = listCodexModels(() => child as CliChild);
    expect(child.sent[0]).toMatchObject({ id: 0, method: "initialize" });
    child.reply(0, {});
    expect(child.sent.slice(1)).toEqual([
      { method: "initialized", params: {} },
      { id: 1, method: "model/list", params: { limit: 100, includeHidden: false } },
    ]);
    child.reply(1, { data: [{ id: "ui-id", model: "model-a", displayName: "Model A", hidden: false }, { model: "hidden", hidden: true }], nextCursor: "next" });
    expect(child.sent.at(-1)).toEqual({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false, cursor: "next" } });
    child.reply(2, { data: [{ model: "model-a" }, { model: "model-b", displayName: "Model B" }], nextCursor: null });
    await expect(result).resolves.toEqual([{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }]);
    expect(child.signals).toContain("SIGTERM");
    child.emit("exit", 0);
  });

  it("rejects Codex protocol errors and shuts down the owned process", async () => {
    const child = new Child();
    const result = listCodexModels(() => child as CliChild);
    const rejected = expect(result).rejects.toThrow("Model discovery unavailable");
    child.stdout.emit("data", Buffer.from('{"id":0,"error":{"message":"Model discovery unavailable"}}\n'));
    await rejected;
    expect(child.signals).toContain("SIGTERM");
    child.emit("exit", 1);
  });

  it("bounds an unresponsive discovery process and escalates termination", async () => {
    vi.useFakeTimers();
    const child = new Child();
    const result = listCodexModels(() => child as CliChild);
    const rejected = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit", 0);
  });
});
