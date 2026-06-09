import { describe, it, expect } from "vitest";
import {
  emptyState,
  deriveTitle,
  newConversation,
  touch,
  saveConversation,
  deleteConversation,
  renameConversation,
  getActive,
  setActive,
  fromPersisted,
  compactMessages,
  relativeTime,
  type Conversation,
} from "../src/conversations/store";
import type { ChatMessage } from "../src/types";

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

describe("deriveTitle", () => {
  it("uses the first non-empty line of the first user message", () => {
    expect(deriveTitle([u("How do I tag notes?\nmore detail")])).toBe("How do I tag notes?");
  });
  it("strips markdown heading and emphasis marks", () => {
    expect(deriveTitle([u("## **Plan** the _release_")])).toBe("Plan the release");
  });
  it("truncates long titles with an ellipsis", () => {
    const long = "x".repeat(80);
    expect(deriveTitle([u(long)])).toBe(`${"x".repeat(60)}…`);
  });
  it("ignores assistant messages and falls back when there is no user text", () => {
    expect(deriveTitle([a("hi")])).toBe("New conversation");
    expect(deriveTitle([])).toBe("New conversation");
  });
});

describe("touch", () => {
  it("names an untitled conversation from its messages and bumps updatedAt", () => {
    const c = newConversation("c1", 1000);
    const t = touch(c, [u("Refactor the parser")], 2000);
    expect(t.title).toBe("Refactor the parser");
    expect(t.updatedAt).toBe(2000);
    expect(t.createdAt).toBe(1000);
  });
  it("preserves a user-given title on later touches", () => {
    let c = newConversation("c1", 1000);
    c = { ...c, title: "My pinned chat" };
    const t = touch(c, [u("something else entirely")], 3000);
    expect(t.title).toBe("My pinned chat");
  });
  it("clones messages (no shared references)", () => {
    const msgs = [u("hello")];
    const t = touch(newConversation("c1", 1), msgs, 2);
    t.messages[0].content = "mutated";
    expect(msgs[0].content).toBe("hello");
  });
});

describe("compactMessages", () => {
  it("removes adjacent duplicate assistant messages left by a double-finish race", () => {
    const first = a("```claude-html\n<div>artifact</div>\n```");
    const dup = a("```claude-html\n<div>artifact</div>\n```");

    expect(compactMessages([u("make an artifact"), first, dup])).toEqual([u("make an artifact"), first]);
  });

  it("removes adjacent duplicate artifacts with incidental markdown differences", () => {
    const first = a("Here you go:\n\n```claude-html height=640\n<title>Dashboard</title><main>same</main>\n```");
    const dup = a("```claude-html\n<title>Dashboard</title><main>same</main>\n```\n\n");

    expect(compactMessages([u("make an artifact"), first, dup])).toEqual([u("make an artifact"), first]);
  });

  it("keeps repeated assistant messages when they are separated by a user turn", () => {
    const reply = a("same text");
    expect(compactMessages([u("one"), reply, u("again"), reply])).toEqual([u("one"), reply, u("again"), reply]);
  });

  it("removes any adjacent assistant-only continuation because chat turns should alternate", () => {
    expect(compactMessages([u("one"), a("first"), a("second")])).toEqual([u("one"), a("first")]);
  });
});

describe("saveConversation", () => {
  it("inserts, orders by recency, and sets active", () => {
    let s = emptyState();
    s = saveConversation(s, { ...newConversation("a", 100), updatedAt: 100 }, 0);
    s = saveConversation(s, { ...newConversation("b", 200), updatedAt: 200 }, 0);
    expect(s.conversations.map((c) => c.id)).toEqual(["b", "a"]);
    expect(s.activeId).toBe("b");
  });
  it("replaces an existing conversation by id rather than duplicating", () => {
    let s = emptyState();
    s = saveConversation(s, { ...newConversation("a", 100), updatedAt: 100 }, 0);
    s = saveConversation(s, { ...newConversation("a", 100), title: "renamed", updatedAt: 300 }, 0);
    expect(s.conversations).toHaveLength(1);
    expect(s.conversations[0].title).toBe("renamed");
  });
  it("prunes to maxKeep oldest-first", () => {
    let s = emptyState();
    for (let i = 1; i <= 5; i++) s = saveConversation(s, { ...newConversation(`c${i}`, i), updatedAt: i }, 3);
    expect(s.conversations.map((c) => c.id)).toEqual(["c5", "c4", "c3"]);
  });
});

describe("deleteConversation", () => {
  it("removes it and re-points active to the most recent remaining", () => {
    let s = emptyState();
    s = saveConversation(s, { ...newConversation("a", 1), updatedAt: 1 }, 0);
    s = saveConversation(s, { ...newConversation("b", 2), updatedAt: 2 }, 0);
    s = setActive(s, "b");
    s = deleteConversation(s, "b");
    expect(s.conversations.map((c) => c.id)).toEqual(["a"]);
    expect(s.activeId).toBe("a");
  });
  it("leaves active null when the last conversation is deleted", () => {
    let s = saveConversation(emptyState(), { ...newConversation("a", 1), updatedAt: 1 }, 0);
    s = deleteConversation(s, "a");
    expect(s.conversations).toEqual([]);
    expect(s.activeId).toBeNull();
  });
});

describe("renameConversation / setActive / getActive", () => {
  it("renames and reads back the active conversation", () => {
    let s = saveConversation(emptyState(), { ...newConversation("a", 1), updatedAt: 1 }, 0);
    s = renameConversation(s, "a", "  Release notes  ");
    expect(getActive(s)?.title).toBe("Release notes");
  });
  it("ignores setActive to an unknown id", () => {
    let s = saveConversation(emptyState(), { ...newConversation("a", 1), updatedAt: 1 }, 0);
    s = setActive(s, "nope");
    expect(s.activeId).toBe("a");
  });
});

describe("fromPersisted", () => {
  it("returns empty state for junk", () => {
    expect(fromPersisted(null)).toEqual(emptyState());
    expect(fromPersisted("nope")).toEqual(emptyState());
    expect(fromPersisted({})).toEqual(emptyState());
  });
  it("keeps only well-formed conversations and orders by recency", () => {
    const good: Conversation = { id: "a", title: "T", createdAt: 1, updatedAt: 5, messages: [u("hi")] };
    const newer: Conversation = { id: "b", title: "U", createdAt: 2, updatedAt: 9, messages: [] };
    const bad = { id: 7, title: "x" };
    const s = fromPersisted({ conversations: [good, bad, newer], activeId: "a" });
    expect(s.conversations.map((c) => c.id)).toEqual(["b", "a"]);
    expect(s.activeId).toBe("a");
  });
  it("drops a dangling activeId to the most recent", () => {
    const c: Conversation = { id: "a", title: "T", createdAt: 1, updatedAt: 1, messages: [] };
    expect(fromPersisted({ conversations: [c], activeId: "ghost" }).activeId).toBe("a");
  });
});

describe("relativeTime", () => {
  const now = 10_000_000_000; // fixed reference
  const ago = (ms: number) => relativeTime(now - ms, now);
  it("buckets recent times", () => {
    expect(ago(10_000)).toBe("just now"); // 10s
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
  });
  it("falls back to an ISO date beyond a week", () => {
    const epoch = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(relativeTime(epoch, epoch + 30 * 86_400_000)).toBe("2026-01-15");
  });
  it("never shows negative time for a future-ish clock skew", () => {
    expect(relativeTime(now + 5000, now)).toBe("just now");
  });
});
