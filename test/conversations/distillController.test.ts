import { describe, expect, it, vi } from "vitest";
import { DistillController, type DistillDeps, type DistillRequest } from "../../src/conversations/distillController";
import type { Conversation } from "../../src/conversations/store";

const reply = JSON.stringify({ title: "Plan", summary: "We planned.", decisions: ["Ship"], facts: [], openItems: [] });

function convo(extra: Partial<Conversation> = {}): Conversation {
  return { id: "c1", title: "Chat", createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }], ...extra };
}

function harness(c: Conversation | undefined, replies: Array<string | Error>, files = new Set<string>()) {
  const calls: DistillRequest[] = [];
  const notices: string[] = [];
  const writes: Array<{ existing: string | null; folder: string; title: string; content: string; created: string }> = [];
  const setNote = vi.fn();
  const queue = [...replies];
  const deps: DistillDeps = {
    get: () => c,
    complete: async (req) => {
      calls.push(req);
      const next = queue.shift();
      if (next === undefined) throw new Error("no reply queued");
      if (next instanceof Error) throw next;
      return next;
    },
    exists: (p) => files.has(p),
    resolveLink: (link) => (link === "Note" ? "Projects/Note.md" : null),
    write: async (existing, folder, title, content, created) => {
      writes.push({ existing, folder, title, content, created });
      const path = existing ?? `${folder}/${created} — ${title}.md`;
      files.add(path);
      return path;
    },
    setDistilledNote: setNote,
    notice: (t) => notices.push(t),
    settings: () => ({ chatFolder: "Claude/Chats", chatBaseTags: ["claude", "chat"] }),
    now: () => new Date("2026-10-05T10:00:00Z"),
  };
  return { controller: new DistillController(deps), calls, notices, writes, setNote, files };
}

describe("DistillController", () => {
  it("empty input notices and makes no model call", async () => {
    const h = harness(convo({ messages: [{ role: "assistant", content: "```claude-html\n<h1>x</h1>\n```" }] }), []);
    expect(await h.controller.distill("c1")).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.notices).toEqual(["Nothing to distill in Chat."]);
    expect(h.writes).toHaveLength(0);
  });

  it("success writes a new note, records it, and sends the schema request", async () => {
    const h = harness(convo(), [reply]);
    const path = await h.controller.distill("c1");
    expect(path).toBe("Claude/Chats/2026-10-05 — Plan.md");
    expect(h.setNote).toHaveBeenCalledWith("c1", path);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ maxTokens: 1200, temperature: 0, responseFormat: "json" });
    expect(h.writes[0]?.existing).toBeNull();
    expect(h.writes[0]?.content).toContain('conversation: "c1"');
    expect(h.notices).toEqual([`Distilled → ${path}`]);
  });

  it("mentions redactions only when there were some", async () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    const h = harness(convo({ messages: [{ role: "user", content: key }] }), [reply]);
    await h.controller.distill("c1");
    expect(h.notices[0]).toMatch(/ · 1 secret redacted$/);
    expect(h.calls[0]?.user).not.toContain("sk-ant-");
  });

  it("pluralizes the redaction count", async () => {
    const key = (c: string) => `sk-ant-api03-${c.repeat(40)}`;
    const h = harness(convo({ messages: [{ role: "user", content: `${key("a")} ${key("b")}` }] }), [reply]);
    await h.controller.distill("c1");
    expect(h.notices[0]).toMatch(/ · 2 secrets redacted$/);
  });

  it("disables thinking on the request and the retry", async () => {
    const h = harness(convo(), ["not json", reply]);
    await h.controller.distill("c1");
    expect(h.calls.map((c) => c.thinking)).toEqual([{ type: "disabled" }, { type: "disabled" }]);
  });

  it("lists notes the chat linked by bare wikilink under their resolved path", async () => {
    const h = harness(convo({ messages: [{ role: "user", content: "see [[Note]]" }] }), [reply]);
    await h.controller.distill("c1");
    expect(h.writes[0]?.content).toContain("[[Projects/Note]]");
  });

  it("re-distill overwrites the existing note in place", async () => {
    const h = harness(convo({ distilledNote: "Claude/Chats/old.md" }), [reply], new Set(["Claude/Chats/old.md"]));
    expect(await h.controller.distill("c1")).toBe("Claude/Chats/old.md");
    expect(h.writes[0]?.existing).toBe("Claude/Chats/old.md");
  });

  it("writes a new note and updates the pointer when the old note was deleted", async () => {
    const h = harness(convo({ distilledNote: "Claude/Chats/gone.md" }), [reply]);
    const path = await h.controller.distill("c1");
    expect(h.writes[0]?.existing).toBeNull();
    expect(path).toBe("Claude/Chats/2026-10-05 — Plan.md");
    expect(h.setNote).toHaveBeenCalledWith("c1", path);
  });

  it("retries once with the rejected reply and parse error, then succeeds", async () => {
    const h = harness(convo(), ["not json", reply]);
    expect(await h.controller.distill("c1")).not.toBeNull();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.user).toContain("not json");
    expect(h.calls[1]?.user).toContain("rejected");
  });

  it("two parse failures notice, write nothing, return null", async () => {
    const h = harness(convo(), ["bad", "worse"]);
    expect(await h.controller.distill("c1")).toBeNull();
    expect(h.calls).toHaveLength(2);
    expect(h.writes).toHaveLength(0);
    expect(h.setNote).not.toHaveBeenCalled();
    expect(h.notices[0]).toMatch(/^Couldn't distill Chat: /);
  });

  it("a provider error notices without retrying", async () => {
    const h = harness(convo(), [new Error("boom")]);
    expect(await h.controller.distill("c1")).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.notices).toEqual(["Couldn't distill Chat: boom"]);
  });

  it("a write failure notices and returns null", async () => {
    const h = harness(convo(), [reply]);
    const failing = new DistillController({ get: () => convo(), complete: async () => reply, exists: () => false, write: async () => { throw new Error("disk"); }, setDistilledNote: h.setNote, notice: (t) => h.notices.push(t), settings: () => ({ chatFolder: "F", chatBaseTags: [] }) });
    expect(await failing.distill("c1")).toBeNull();
    expect(h.notices).toEqual(["Couldn't distill Chat: disk"]);
  });

  it("unknown conversation returns null silently", async () => {
    const h = harness(undefined, []);
    expect(await h.controller.distill("c1")).toBeNull();
    expect(h.notices).toHaveLength(0);
  });

  it("coalesces concurrent distills of one conversation into one model call", async () => {
    const h = harness(convo(), [reply]);
    const [a, b] = await Promise.all([h.controller.distill("c1"), h.controller.distill("c1")]);
    expect(a).toBe(b);
    expect(h.calls).toHaveLength(1);
  });
});
