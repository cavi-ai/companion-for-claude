import { describe, it, expect } from "vitest";
import { withCacheControl, countBreakpoints } from "../src/claude/cache";
import type { AnthropicToolDef, ApiMessage } from "../src/providers/types";

const EPHEMERAL = { type: "ephemeral" };
const tools: AnthropicToolDef[] = [
  { name: "vault_search", description: "s", input_schema: { type: "object" } },
  { name: "note_read", description: "r", input_schema: { type: "object" } },
];
const user = (content: ApiMessage["content"]): ApiMessage => ({ role: "user", content });
const assistant = (content: ApiMessage["content"]): ApiMessage => ({ role: "assistant", content });

describe("withCacheControl — system", () => {
  it("wraps a string system into blocks with a trailing breakpoint (API-key mode)", () => {
    const r = withCacheControl({ system: "Be concise.", messages: [user("hi")] });
    expect(r.system).toEqual([{ type: "text", text: "Be concise.", cache_control: EPHEMERAL }]);
  });

  it("marks only the last block of an OAuth block-array system, preserving block 0 text", () => {
    const r = withCacheControl({
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "Be concise." },
      ],
      messages: [user("hi")],
    });
    expect(r.system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "Be concise.", cache_control: EPHEMERAL },
    ]);
  });

  it("passes undefined system through", () => {
    expect(withCacheControl({ system: undefined, messages: [user("hi")] }).system).toBeUndefined();
  });
});

describe("withCacheControl — tools", () => {
  it("marks only the last tool definition", () => {
    const r = withCacheControl({ system: "s", tools, messages: [user("hi")] });
    expect(r.tools?.[0]).toEqual(tools[0]);
    expect(r.tools?.[1]).toEqual({ ...tools[1], cache_control: EPHEMERAL });
  });

  it("omits tools when absent", () => {
    expect(withCacheControl({ system: "s", messages: [user("hi")] }).tools).toBeUndefined();
  });

  it("does not mutate the caller's tool defs", () => {
    withCacheControl({ system: "s", tools, messages: [user("hi")] });
    expect(tools[1]).not.toHaveProperty("cache_control");
  });
});

describe("withCacheControl — messages", () => {
  it("converts the latest user message's string content to a flagged text block", () => {
    const messages = [user("first"), assistant("reply"), user("second")];
    const r = withCacheControl({ system: "s", messages });
    expect(r.messages[2]).toEqual({ role: "user", content: [{ type: "text", text: "second", cache_control: EPHEMERAL }] });
    // earlier messages untouched
    expect(r.messages[0]).toEqual(user("first"));
    expect(r.messages[1]).toEqual(assistant("reply"));
    expect(messages[2]).toEqual(user("second")); // input not mutated
  });

  it("flags the last block of a block-content user message (tool_result turn)", () => {
    const messages: ApiMessage[] = [
      user("go"),
      assistant([{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "vault_search", input: {} }]),
      user([
        { type: "tool_result", tool_use_id: "t1", content: "hits" },
        { type: "tool_result", tool_use_id: "t2", content: "more" },
      ]),
    ];
    const r = withCacheControl({ system: "s", messages });
    const last = r.messages[2] as { content: Array<Record<string, unknown>> };
    expect(last.content[0]).not.toHaveProperty("cache_control");
    expect(last.content[1]).toMatchObject({ tool_use_id: "t2", cache_control: EPHEMERAL });
  });

  it("skips the breakpoint when the latest user message is empty", () => {
    const messages = [user("")];
    const r = withCacheControl({ system: "s", messages });
    expect(r.messages[0]).toEqual(user(""));
  });

  it("targets the latest USER message even when an assistant message is last", () => {
    const messages = [user("q"), assistant("a")];
    const r = withCacheControl({ system: "s", messages });
    expect(r.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "q", cache_control: EPHEMERAL }] });
    expect(r.messages[1]).toEqual(assistant("a"));
  });
});

describe("breakpoint budget", () => {
  it("never exceeds the API limit of 4", () => {
    const r = withCacheControl({
      system: [
        { type: "text", text: "id" },
        { type: "text", text: "sys" },
      ],
      tools,
      messages: [user("a"), assistant("b"), user([{ type: "tool_result", tool_use_id: "t", content: "r" }])],
    });
    expect(countBreakpoints(r)).toBe(3);
    expect(countBreakpoints(r)).toBeLessThanOrEqual(4);
  });
});

describe("withCacheControl — media blocks", () => {
  it("flags the trailing text block after attached media", () => {
    const messages: ApiMessage[] = [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } },
          { type: "text", text: "Summarize this PDF." },
        ],
      },
    ];
    const r = withCacheControl({ system: "s", messages });
    const content = (r.messages[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).not.toHaveProperty("cache_control");
    expect(content[1]).toMatchObject({ type: "text", cache_control: EPHEMERAL });
  });
});
