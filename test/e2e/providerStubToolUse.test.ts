import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { parseSseChunk } from "../../src/claude/sse";
import { freshStubState, startProviderStub } from "../../e2e/rig/stubs";

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function post(replies: string[]): Promise<string> {
  const state = freshStubState();
  state.replyRules = [{ match: "go", replies }];
  const started = await startProviderStub(state);
  server = started.server;
  const response = await fetch(`http://127.0.0.1:${started.port}/v1/messages`, { method: "POST", body: JSON.stringify({ stream: true, messages: ["go"] }) });
  return response.text();
}

describe("e2e provider stub tool_use replies", () => {
  it("streams a TOOL_USE reply as one tool_use block the SSE parser completes", async () => {
    const input = { path: "A.md", edits: [{ old_str: "a", new_str: "b" }] };
    const parsed = parseSseChunk(await post([`TOOL_USE:${JSON.stringify({ name: "propose_note_edit", input })}`]));
    expect(parsed.stopReason).toBe("tool_use");
    expect(parsed.toolUses).toHaveLength(1);
    expect(parsed.toolUses[0]).toMatchObject({ name: "propose_note_edit", input });
    expect(parsed.toolUses[0]?.id).toMatch(/^toolu_stub_/);
    expect(parsed.toolUses[0]?.parseError).toBeUndefined();
  });

  it("still streams plain text replies", async () => {
    const parsed = parseSseChunk(await post(["hello"]));
    expect(parsed.text).toBe("hello");
    expect(parsed.toolUses).toEqual([]);
  });
});
