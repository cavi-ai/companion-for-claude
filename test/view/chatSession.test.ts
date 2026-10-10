import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "../../src/view/chat/chatSession";
import { defaultChatControls } from "../../src/claude/chatControls";
import { DEFAULT_SETTINGS } from "../../src/types";

describe("ChatSession", () => {
  it("clears to a fresh conversation: no messages or usage, outside Plan Mode, controls and write grant kept", async () => {
    const chat = new ChatSession({ writes: () => true, setWrites: vi.fn(), save: vi.fn(async () => undefined), notify: vi.fn() });
    const controls = defaultChatControls(DEFAULT_SETTINGS.model);
    chat.controls = controls;
    chat.writeGrant = true;
    chat.messages = [{ role: "user", content: "hi" }];
    chat.turn.session = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 };
    await chat.mode.change("plan");

    chat.clear();

    expect(chat.messages).toEqual([]);
    expect(chat.turn.session.requests).toBe(0);
    expect(chat.mode.mode).toBe("act");
    expect(chat.controls).toBe(controls);
    expect(chat.writeGrant).toBe(true);
  });
});
