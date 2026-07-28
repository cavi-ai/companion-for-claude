import { describe, it, expect } from "vitest";
import { completeJsonWithRepair } from "../../src/providers/jsonRepair";
import type { CompletionRequest, Provider } from "../../src/providers/types";

const REQ: CompletionRequest = { system: "s", messages: [{ role: "user", content: "go" }], model: "m", maxTokens: 100 };

function fakeProvider(replies: string[]): Provider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    id: "anthropic" as const,
    label: "fake",
    hasCredentials: () => true,
    stream: () => Promise.resolve(),
    test: () => Promise.resolve({ ok: true, detail: "" }),
    complete: (req: CompletionRequest) => {
      calls.push(req);
      return Promise.resolve(replies[calls.length - 1] ?? "");
    },
  };
}

const parseJson = (raw: string): unknown => JSON.parse(raw);

describe("completeJsonWithRepair", () => {
  it("returns the first reply when it parses", async () => {
    const p = fakeProvider(['{"a":1}']);
    const r = await completeJsonWithRepair(p, REQ, parseJson);
    expect(r).toMatchObject({ raw: '{"a":1}', response: { a: 1 }, repaired: false });
    expect(p.calls).toHaveLength(1);
  });

  it("repairs once with the bad reply echoed back, then succeeds", async () => {
    const p = fakeProvider(["not json", '{"a":2}']);
    const r = await completeJsonWithRepair(p, REQ, parseJson);
    expect(r).toMatchObject({ raw: '{"a":2}', response: { a: 2 }, repaired: true });
    expect(p.calls).toHaveLength(2);
    const repair = p.calls[1];
    expect(repair?.messages.at(-2)).toEqual({ role: "assistant", content: "not json" });
    expect(String(repair?.messages.at(-1)?.content)).toContain("Your previous JSON was rejected");
  });

  it("throws when the repair reply also fails to parse", async () => {
    const p = fakeProvider(["bad", "still bad"]);
    await expect(completeJsonWithRepair(p, REQ, parseJson)).rejects.toThrow();
    expect(p.calls).toHaveLength(2); // never a third attempt
  });
});
