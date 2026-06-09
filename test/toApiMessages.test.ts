import { describe, it, expect } from "vitest";
import { toApiMessages } from "../src/conversations/store";
import type { ChatMessage } from "../src/types";

describe("toApiMessages", () => {
  it("leaves an already-alternating list unchanged", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toApiMessages(msgs)).toEqual(msgs);
  });

  it("merges consecutive user messages (the failed-turn case that 400s)", () => {
    const out = toApiMessages([
      { role: "user", content: "first (failed)" },
      { role: "user", content: "second" },
    ]);
    expect(out).toEqual([{ role: "user", content: "first (failed)\n\nsecond" }]);
  });

  it("merges consecutive assistant messages too", () => {
    const out = toApiMessages([
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(out).toEqual([{ role: "assistant", content: "a\n\nb" }]);
  });

  it("does not mutate the input", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "x" },
      { role: "user", content: "y" },
    ];
    toApiMessages(msgs);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("x");
  });
});
