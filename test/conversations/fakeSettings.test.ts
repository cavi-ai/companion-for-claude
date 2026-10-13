import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import { conversationFakes } from "../fakes/conversations";

const input = { backend: "claude", model: DEFAULT_SETTINGS.model, mode: "ask" } as const;

describe("conversation fakes settings", () => {
  it("applies the settings object the caller passes", async () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), maxConversations: 1 };
    const { conversations } = conversationFakes({}, settings);
    await conversations.beginTurn(null, [{ role: "user", content: "one" }], input);
    await conversations.beginTurn(null, [{ role: "user", content: "two" }], input);
    expect(conversations.list()).toHaveLength(1);
  });
});
