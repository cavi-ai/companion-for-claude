import { describe, it, expect } from "vitest";
import { continuationFor, shouldAutoContinue, MAX_AUTO_CONTINUATIONS } from "../src/view/chat/continuation";
import type { ChatTurnReceipt } from "../src/conversations/store";

const receipt = (state: ChatTurnReceipt["state"], extra: Partial<ChatTurnReceipt> = {}): ChatTurnReceipt => ({
  id: "t1", state, backend: "anthropic", model: "m", mode: "act", userMessageIndex: 0, createdAt: 1, updatedAt: 1, ...extra,
});

describe("continuationFor", () => {
  it("builds a handoff-driven continue prompt for capped turns", () => {
    const c = continuationFor(receipt("capped", { handoff: "Tools used: vault_search", continuationDepth: 1 }));
    expect(c?.display).toBe("Continue task");
    expect(c?.depth).toBe(2);
    expect(c?.prompt).toContain("Tools used: vault_search");
    expect(c?.prompt).toContain("Do not repeat completed writes");
  });

  it("falls back to a generic continue prompt when the cap carried no handoff", () => {
    const c = continuationFor(receipt("capped"));
    expect(c?.depth).toBe(1);
    expect(c?.prompt).toContain("continue only unfinished work");
  });

  it("resumes interrupted and failed turns at depth zero", () => {
    expect(continuationFor(receipt("interrupted"))).toMatchObject({ display: "Resume interrupted task", depth: 0 });
    expect(continuationFor(receipt("failed"))).toMatchObject({ display: "Resume interrupted task", depth: 0 });
  });

  it("returns null for running turns", () => {
    expect(continuationFor(receipt("running"))).toBeNull();
  });
});

describe("shouldAutoContinue", () => {
  it("requires the setting, a capped receipt, and depth under the cap", () => {
    expect(shouldAutoContinue(true, receipt("capped"))).toBe(true);
    expect(shouldAutoContinue(false, receipt("capped"))).toBe(false);
    expect(shouldAutoContinue(true, receipt("interrupted"))).toBe(false);
    expect(shouldAutoContinue(true, undefined)).toBe(false);
    expect(shouldAutoContinue(true, receipt("capped", { continuationDepth: MAX_AUTO_CONTINUATIONS }))).toBe(false);
    expect(shouldAutoContinue(true, receipt("capped", { continuationDepth: MAX_AUTO_CONTINUATIONS - 1 }))).toBe(true);
  });
});
