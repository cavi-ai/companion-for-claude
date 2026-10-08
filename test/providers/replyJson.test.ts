import { describe, expect, it } from "vitest";
import { replyJson } from "../../src/providers/replyJson";
import { isRecord as isJsonObject } from "../../src/records";

describe("replyJson", () => {
  it("reads bare JSON, a fenced block, and JSON wrapped in prose", () => {
    expect(replyJson('{"a":1}')).toEqual({ a: 1 });
    expect(replyJson('Here:\n```json\n{"a":"b"}\n```\nthanks')).toEqual({ a: "b" });
    expect(replyJson('```\n[1, 2]\n```')).toEqual([1, 2]);
    expect(replyJson('Sure! {"verdicts": [{"n": 1}]} Hope that helps.')).toEqual({ verdicts: [{ n: 1 }] });
  });

  it("keeps braces inside strings and ignores a later stray brace", () => {
    expect(replyJson('Result: {"title": "a } b", "x": "{"} — and a closing } here')).toEqual({ title: "a } b", x: "{" });
    expect(replyJson('{"q": "say \\"hi\\" }"} trailing }')).toEqual({ q: 'say "hi" }' });
  });

  it("returns the first value `accept` takes", () => {
    expect(replyJson('[1] then {"a": 2}', isJsonObject)).toEqual({ a: 2 });
    expect(replyJson('{"a": 1} then [2]', Array.isArray)).toEqual([2]);
  });

  it("is undefined when no candidate parses or is accepted", () => {
    expect(replyJson("no json here")).toBeUndefined();
    expect(replyJson("{ broken }")).toBeUndefined();
    expect(replyJson("[1, 2]", isJsonObject)).toBeUndefined();
  });

  it("stays linear on long prose full of unbalanced braces", () => {
    const raw = `${"{ ".repeat(20_000)}${"} ".repeat(20_000)}`;
    const started = performance.now();
    expect(replyJson(raw)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
