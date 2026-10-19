import { describe, expect, it } from "vitest";
import { replyContextSection } from "../../src/artifacts/replyContext";

describe("saved reply context", () => {
  it("does not invent context for legacy replies or empty snapshots", () => {
    expect(replyContextSection(undefined, "Claude/Chats")).toBe("");
    expect(replyContextSection([], "Claude/Chats")).toBe("");
  });
  it("ignores malformed persisted context instead of inventing or crashing", () => {
    for (const value of [3, "active note: A.md", ["active note: A.md", null]]) {
      expect(replyContextSection(value as never, "Claude/Chats")).toBe("");
    }
  });
  it("links recorded notes relative to the saved folder and preserves count-only labels", () => {
    expect(replyContextSection(["active note: Notes/Pilot #1.md", "selection: Notes/Pilot #1.md", "3 search matches", "3 search matches"], "Claude/Chats/")).toBe(
      "\n\n## Context provided\n\n- [active note: Notes/Pilot #1.md](../../Notes/Pilot%20%231.md)\n- [selection: Notes/Pilot #1.md](../../Notes/Pilot%20%231.md)\n- 3 search matches\n",
    );
  });
  it("escapes labels and URLs without changing the original context", () => {
    expect(replyContextSection(["active note: A [draft](1).md", "<script>\n*text*"], "")).toBe(
      "\n\n## Context provided\n\n- [active note: A \\[draft\\](1).md](A%20%5Bdraft%5D%281%29.md)\n- \\<script\\> \\*text\\*\n",
    );
  });
});
