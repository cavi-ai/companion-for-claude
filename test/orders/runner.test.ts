import { describe, expect, it } from "vitest";
import { buildOrderPrompt, runOrder, type OrderRunDeps, type OrderTurnRequest } from "../../src/orders/runner";
import type { StandingOrder } from "../../src/orders/order";
import type { McpToolDef } from "../../src/mcp/protocol";
import type { ToolUseBlock } from "../../src/providers/types";

const order: StandingOrder = { id: "o.md", name: "Follow ups", path: "o.md", prompt: "Review {note} on {date}.", enabled: true, onNote: { folder: "Meetings" } };
const NOW = new Date(2026, 9, 2, 14, 5);
const noteTrigger = { kind: "note" as const, path: "Meetings/a.md", content: "- [ ] ship" };
const WRITES = new Set(["note_create", "note_update", "research_claim_create"]);
const tool = (name: string): McpToolDef => ({ name, description: name, inputSchema: {}, annotations: { readOnlyHint: !WRITES.has(name) } });
const block = (input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: "t1", name: "propose_note_edit", input });

function deps(over: Partial<OrderRunDeps> = {}): OrderRunDeps & { requests: OrderTurnRequest[] } {
  const requests: OrderTurnRequest[] = [];
  return {
    requests,
    vaultTools: [tool("vault_search"), tool("note_read")],
    toolsSupported: true,
    readNote: async () => "- [ ] ship\n",
    runTurn: async (request) => {
      requests.push(request);
      return { text: "done", trace: [] };
    },
    ...over,
  };
}

describe("buildOrderPrompt", () => {
  it("substitutes {date} and {note}", () => {
    expect(buildOrderPrompt(order, noteTrigger, NOW)).toBe("Review Note: Meetings/a.md\n\n- [ ] ship on 2026-10-02.");
  });

  it("appends the note when the body has no {note}", () => {
    const bare = { ...order, prompt: "Summarise." };
    expect(buildOrderPrompt(bare, noteTrigger, NOW)).toBe("Summarise.\n\nNote: Meetings/a.md\n\n- [ ] ship");
  });

  it("leaves {note} empty for a schedule run", () => {
    expect(buildOrderPrompt(order, { kind: "schedule" }, NOW)).toBe("Review  on 2026-10-02.");
    expect(buildOrderPrompt({ ...order, prompt: "Summarise." }, { kind: "schedule" }, NOW)).toBe("Summarise.");
  });
});

describe("runOrder", () => {
  it("offers read tools plus propose_note_edit and the order model, under propose-only access", async () => {
    const d = deps();
    await runOrder({ ...order, model: "m1" }, noteTrigger, NOW, d);
    expect(d.requests[0]?.tools.map((t) => t.name)).toEqual(["vault_search", "note_read", "propose_note_edit"]);
    expect(d.requests[0]?.model).toBe("m1");
    expect(d.requests[0]?.run).toBe("propose");
  });

  it("never offers a write tool from the vault catalog", async () => {
    const d = deps({ vaultTools: [tool("vault_search"), tool("note_create"), tool("note_update"), tool("research_claim_create")] });
    await runOrder(order, noteTrigger, NOW, d);
    const names = d.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("propose_note_edit");
    expect(names).not.toContain("note_create");
    expect(names).not.toContain("note_update");
    expect(names).not.toContain("research_claim_create");
  });

  it("runs without tools when the model cannot use them", async () => {
    const d = deps({ toolsSupported: false });
    const result = await runOrder(order, noteTrigger, NOW, d);
    expect(d.requests[0]?.tools).toEqual([]);
    expect(d.requests[0]?.run).toBe("off");
    expect(result.error).toBeUndefined();
  });

  it("queues a proposal instead of applying it", async () => {
    const written: string[] = [];
    const d = deps({
      readNote: async (path) => { written.push(path); return "- [ ] ship\n"; },
      runTurn: async (_request, proposeEdit) => {
        const reply = await proposeEdit(block({ path: "Meetings/a.md", edits: [{ old_str: "- [ ] ship", new_str: "- [x] ship" }], description: "Mark shipped" }));
        return { text: reply, trace: [] };
      },
    });
    const result = await runOrder(order, noteTrigger, NOW, d);
    expect(result.text).toBe("Queued for review.");
    expect(result.proposals).toEqual([{ path: "Meetings/a.md", edits: [{ old_str: "- [ ] ship", new_str: "- [x] ship" }], description: "Mark shipped" }]);
    expect(written).toEqual(["Meetings/a.md"]);
  });

  it("rejects a stale proposal back to the model and queues nothing", async () => {
    let thrown = "";
    const d = deps({
      runTurn: async (_request, proposeEdit) => {
        try {
          await proposeEdit(block({ path: "Meetings/a.md", edits: [{ old_str: "gone text", new_str: "x" }] }));
        } catch (error) {
          thrown = (error as Error).message;
        }
        return { text: "", trace: [] };
      },
    });
    const result = await runOrder(order, noteTrigger, NOW, d);
    expect(thrown).toContain("old_str not found");
    expect(result.proposals).toEqual([]);
  });

  it("rejects a proposal without a path or edits, and a missing note", async () => {
    const messages: string[] = [];
    const d = deps({
      readNote: async () => { throw new Error("Note not found: x.md"); },
      runTurn: async (_request, proposeEdit) => {
        for (const input of [{ edits: [{ old_str: "a", new_str: "b" }] }, { path: "x.md" }, { path: "x.md", edits: [{ old_str: "a", new_str: "b" }] }]) {
          await proposeEdit(block(input)).catch((error: Error) => messages.push(error.message));
        }
        return { text: "", trace: [] };
      },
    });
    const result = await runOrder(order, { kind: "schedule" }, NOW, d);
    expect(messages).toEqual(["propose_note_edit requires a 'path'.", "propose_note_edit requires a non-empty 'edits' array.", "Note not found: x.md"]);
    expect(result.proposals).toEqual([]);
  });

  it("keeps proposals when the turn errors and reports the error", async () => {
    const d = deps({
      runTurn: async (_request, proposeEdit) => {
        await proposeEdit(block({ path: "Meetings/a.md", edits: [{ old_str: "- [ ] ship", new_str: "- [x] ship" }] }));
        return { text: "partial", trace: [], error: new Error("rate limited") };
      },
    });
    const result = await runOrder(order, noteTrigger, NOW, d);
    expect(result.error?.message).toBe("rate limited");
    expect(result.proposals).toHaveLength(1);
    expect(result.text).toBe("partial");
  });

  it("turns a thrown turn into an error result", async () => {
    const d = deps({ runTurn: async () => { throw new Error("boom"); } });
    const result = await runOrder(order, noteTrigger, NOW, d);
    expect(result.error?.message).toBe("boom");
    expect(result.proposals).toEqual([]);
  });
});
