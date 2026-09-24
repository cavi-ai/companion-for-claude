import { describe, expect, it, vi } from "vitest";
import type { AgentTurnResult } from "../../src/agent/loop";
import { ChatTurnService } from "../../src/chat/turnService";
import { shouldNotifyTurnComplete } from "../../src/chat/turnNotice";

const DONE: AgentTurnResult = { text: "answer", trace: [] };
const EMPTY_FAILURE: AgentTurnResult = { text: "", trace: [], error: new Error("boom") };

describe("shouldNotifyTurnComplete", () => {
  it("notifies for a completed unattached turn when the setting is on", () => {
    expect(shouldNotifyTurnComplete(true, DONE)).toBe(true);
  });

  it("does not notify when the setting is off", () => {
    expect(shouldNotifyTurnComplete(false, DONE)).toBe(false);
  });

  it("does not notify for a turn that produced nothing at all (an empty failure)", () => {
    expect(shouldNotifyTurnComplete(true, EMPTY_FAILURE)).toBe(false);
  });
});

describe("ChatTurnService onUnattachedDone → Notice wiring", () => {
  it("fires only when the turn settles with no subscriber attached", async () => {
    const service = new ChatTurnService();
    const notified = vi.fn();
    service.onUnattachedDone(({ title, result }) => {
      if (shouldNotifyTurnComplete(true, result)) notified(title);
    });

    const handle = service.start("conversation-1", {
      turnId: "turn-1",
      title: "Unattached turn",
      run: async () => DONE,
      completeTurn: async () => undefined,
      interruptTurn: async () => undefined,
      registerTurn: () => () => undefined,
    });
    await handle.result;

    expect(notified).toHaveBeenCalledExactlyOnceWith("Unattached turn");
  });

  it("does not fire when a subscriber is attached at completion", async () => {
    const service = new ChatTurnService();
    const notified = vi.fn();
    service.onUnattachedDone(({ title, result }) => {
      if (shouldNotifyTurnComplete(true, result)) notified(title);
    });

    const handle = service.start("conversation-2", {
      turnId: "turn-2",
      title: "Attached turn",
      run: async () => DONE,
      completeTurn: async () => undefined,
      interruptTurn: async () => undefined,
      registerTurn: () => () => undefined,
    });
    const unsubscribe = service.subscribe("conversation-2", () => undefined);
    await handle.result;
    unsubscribe();

    expect(notified).not.toHaveBeenCalled();
  });
});
