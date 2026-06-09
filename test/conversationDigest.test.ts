import { describe, it, expect } from "vitest";
import { digestConversation } from "../src/memory/conversationDigest";

describe("digestConversation", () => {
  it("maps chat messages to a digest, counting turns and skipping blanks", () => {
    const d = digestConversation(
      [
        { role: "user", content: "Plan a feature" },
        { role: "assistant", content: "Here's a plan." },
        { role: "user", content: "   " }, // blank → skipped
        { role: "assistant", content: "More detail." },
      ],
      { sessionId: "conv-1", model: "claude-opus-4-8", startedAt: "2026-06-03T00:00:00Z" },
    );
    expect(d.sessionId).toBe("conv-1");
    expect(d.userTurns).toBe(1);
    expect(d.assistantTurns).toBe(2);
    expect(d.prose.map((p) => p.text)).toEqual(["Plan a feature", "Here's a plan.", "More detail."]);
    expect(d.toolActions).toEqual([]);
    expect(d.filesTouched).toEqual([]);
  });

  it("handles an empty conversation", () => {
    const d = digestConversation([]);
    expect(d.userTurns).toBe(0);
    expect(d.assistantTurns).toBe(0);
    expect(d.prose).toEqual([]);
  });
});
