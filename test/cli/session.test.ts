import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { ClaudeCliSession, userMessageLine } from "../../src/cli/session";
import type { CompletionRequest } from "../../src/providers/types";

class FakeStdin {
  writes: string[] = [];
  ended = false;
  write(chunk: string, cb?: (err?: Error | null) => void): boolean { this.writes.push(chunk); cb?.(null); return true; }
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
const init = '{"type":"system","subtype":"init","session_id":"s1","model":"m","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\n';
const text = (t: string) => `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${t}"}}}\n`;
const result = (t: string, subtype = "success") => `{"type":"result","subtype":"${subtype}","result":"${t}","session_id":"s1","is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}\n`;
const errorResult = (t: string) => `{"type":"result","subtype":"success","result":"${t}","session_id":"s1","is_error":true,"api_error_status":404,"usage":{"input_tokens":0,"output_tokens":0}}\n`;

function session(transcript?: string): { s: ClaudeCliSession; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const s = new ClaudeCliSession({ spawn: () => { const c = new FakeChild(); children.push(c); return c; }, ...(transcript !== undefined ? { transcript } : {}) });
  return { s, children };
}
const feed = (c: FakeChild, s: string) => c.stdout.emit("data", Buffer.from(s));

describe("userMessageLine", () => {
  it("wraps the last user message as a stream-json user line", () => {
    expect(JSON.parse(userMessageLine(req, null))).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  });
  it("prepends the transcript block once when given", () => {
    const line = JSON.parse(userMessageLine(req, "Conversation so far:\nu: hi"));
    expect(line.message.content[0]).toEqual({ type: "text", text: "Conversation so far:\nu: hi" });
    expect(line.message.content[1]).toEqual({ type: "text", text: "hello" });
  });
  it("carries image and document blocks through", () => {
    const withImage: CompletionRequest = { ...req, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "what is this" }] }] };
    const line = JSON.parse(userMessageLine(withImage, null));
    expect(line.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "what is this" }]);
  });
});

describe("ClaudeCliSession", () => {
  it("spawns on first run, writes the user line, streams text, resolves on result", async () => {
    const { s, children } = session();
    const text_: string[] = [];
    const turn = s.run(req, { onText: (d) => text_.push(d) });
    expect(children).toHaveLength(1);
    expect(children[0]!.stdin.writes).toHaveLength(1);
    feed(children[0]!, init + text("po") + text("ng") + result("pong"));
    const r = await turn;
    expect(r.text).toBe("pong");
    expect(text_.join("")).toBe("pong");
    expect(s.sessionId()).toBe("s1");
  });

  it("surfaces an is_error result as a turn error instead of an empty reply", async () => {
    const { s, children } = session();
    const text_: string[] = [];
    const turn = s.run(req, { onText: (d) => text_.push(d) });
    feed(children[0]!, init + errorResult("There's an issue with the selected model (e2e-model)."));
    const r = await turn;
    expect(r.text).toBe("");
    expect(r.error?.message).toContain("selected model (e2e-model)");
  });

  it("reuses the process for the next turn and injects the transcript only once", async () => {
    const { s, children } = session("Conversation so far:\nu: earlier");
    const first = s.run(req, { onText: () => undefined });
    feed(children[0]!, init + result("a"));
    await first;
    const second = s.run(req, { onText: () => undefined });
    feed(children[0]!, result("b"));
    await second;
    expect(children).toHaveLength(1);
    const lines = children[0]!.stdin.writes.map((w) => JSON.parse(w));
    expect(lines[0].message.content[0].text).toContain("Conversation so far");
    expect(lines[1].message.content).toHaveLength(1);
  });

  it("rejects a second run while one is streaming", async () => {
    const { s, children } = session();
    const first = s.run(req, { onText: () => undefined });
    await expect(s.run(req, { onText: () => undefined })).rejects.toThrow(/already running/);
    feed(children[0]!, init + result("x"));
    await first;
  });

  it("records tool_use and tool_result as a trace and fires the chip handlers", async () => {
    const { s, children } = session();
    const started: string[] = [];
    const finished: string[] = [];
    const turn = s.run(req, { onText: () => undefined, onToolStart: (b) => started.push(b.name), onToolResult: (b, r) => finished.push(`${b.name}:${r.is_error ? "err" : "ok"}`) });
    feed(children[0]!, init
      + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__obsidian-vault__note_create","input":{"title":"S"}}]}}\n'
      + '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"User declined.","is_error":true}]}}\n'
      + text("DENIED") + result("DENIED"));
    const r = await turn;
    expect(started).toEqual(["mcp__obsidian-vault__note_create"]);
    expect(finished).toEqual(["mcp__obsidian-vault__note_create:err"]);
    expect(r.trace).toEqual([{ name: "mcp__obsidian-vault__note_create", argsSummary: '{"title":"S"}', resultPreview: "User declined.", ok: false }]);
    expect(r.text).toBe("DENIED");
  });

  it("fails the turn and interrupts when the bridge did not connect", async () => {
    const { s, children } = session();
    const turn = s.run(req, { onText: () => undefined });
    feed(children[0]!, '{"type":"system","subtype":"init","session_id":"s1","model":"m","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"failed"}]}\n');
    const r = await turn;
    expect(r.error?.message).toMatch(/MCP bridge not connected \(obsidian-vault: failed\)/);
    expect(children[0]!.signals).toContain("SIGINT");
  });

  it("maps error_max_turns to capped and reports usage", async () => {
    const { s, children } = session();
    const usage: number[] = [];
    const notices: string[] = [];
    const turn = s.run(req, { onText: () => undefined, onUsage: (u) => usage.push(u.output_tokens ?? 0), onNotice: (n) => notices.push(n) });
    feed(children[0]!, init + result("partial", "error_max_turns"));
    const r = await turn;
    expect(r.capped).toBe(true);
    expect(usage).toEqual([1]);
    expect(notices[0]).toMatch(/tool iteration/);
  });

  it("fails a turn when the process exits mid-stream, with the stderr tail", async () => {
    const { s, children } = session();
    const turn = s.run(req, { onText: () => undefined });
    children[0]!.stderr.emit("data", Buffer.from("boom: not logged in"));
    children[0]!.emit("exit", 1);
    const r = await turn;
    expect(r.error?.message).toMatch(/exited \(code 1\).*not logged in/);
    expect(s.isClosed()).toBe(true);
  });

  it("interrupt sends SIGINT; close ends stdin and terminates", async () => {
    const { s, children } = session();
    const turn = s.run(req, { onText: () => undefined });
    s.interrupt();
    expect(children[0]!.signals).toEqual(["SIGINT"]);
    feed(children[0]!, init + result(""));
    await turn;
    const closing = s.close();
    children[0]!.emit("exit", 0);
    await closing;
    expect(children[0]!.stdin.ended).toBe(true);
    expect(s.isClosed()).toBe(true);
    await expect(s.run(req, { onText: () => undefined })).rejects.toThrow(/closed/);
  });

  it("interrupt sends SIGINT, the aborted result still settles the turn, and the session is spent", async () => {
    const { s, children } = session();
    const turn = s.run(req, { onText: () => {} });
    feed(children[0]!, init + text("1"));
    s.interrupt();
    expect(children[0]!.signals).toEqual(["SIGINT"]);
    expect(s.isClosed()).toBe(true);
    feed(children[0]!, result(""));
    children[0]!.emit("exit", 0);
    const r = await turn;
    expect(r.text).toBe("1");
    expect(r.error).toBeUndefined();
    await expect(s.run(req, { onText: () => {} })).rejects.toThrow(/closed/);
    expect(children).toHaveLength(1);
  });

  it("a process exit closes the session so the next turn gets a fresh one from the registry", async () => {
    const { s, children } = session();
    const turn = s.run(req, { onText: () => {} });
    feed(children[0]!, init + text("par"));
    children[0]!.emit("exit", 0);
    const r = await turn;
    expect(r.error?.message).toContain("exited (code 0)");
    expect(s.isClosed()).toBe(true);
  });
});
