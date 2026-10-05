import { describe, expect, it } from "vitest";
import {
  archiveConversation,
  forkConversation,
  fromPersisted,
  saveConversation,
  seededConversation,
  setDistilledNote,
  unarchiveConversation,
  type Conversation,
  type ConversationState,
} from "../../src/conversations/store";

function convo(id: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation {
  return { id, title: `T-${id}`, createdAt: 1, updatedAt, messages: [{ role: "user", content: "hi" }], ...extra };
}

function stateOf(conversations: Conversation[], activeId: string | null = null): ConversationState {
  return { conversations, activeId };
}

describe("archive", () => {
  it("archives and unarchives without touching activeId", () => {
    const s = stateOf([convo("a", 5), convo("b", 4)], "a");
    const archived = archiveConversation(s, "a", 99);
    expect(archived.conversations.find((c) => c.id === "a")?.archivedAt).toBe(99);
    expect(archived.activeId).toBe("a");
    const restored = unarchiveConversation(archived, "a");
    expect(restored.conversations.find((c) => c.id === "a")?.archivedAt).toBeUndefined();
    expect("archivedAt" in restored.conversations[0]!).toBe(false);
  });

  it("prune keeps every archived conversation and caps only unarchived ones", () => {
    const archived = Array.from({ length: 5 }, (_, i) => convo(`arch${i}`, 1 + i, { archivedAt: 1 }));
    const live = Array.from({ length: 200 }, (_, i) => convo(`live${i}`, 1000 + i));
    const s = stateOf([...archived, ...live], "live199");
    const next = saveConversation(s, convo("fresh", 5000), 200);
    expect(next.conversations.filter((c) => c.archivedAt !== undefined)).toHaveLength(5);
    const unarchived = next.conversations.filter((c) => c.archivedAt === undefined);
    expect(unarchived).toHaveLength(200);
    expect(unarchived.some((c) => c.id === "live0")).toBe(false);
    expect(unarchived.some((c) => c.id === "fresh")).toBe(true);
  });

  it("maxKeep <= 0 stays unbounded", () => {
    const s = stateOf(Array.from({ length: 5 }, (_, i) => convo(`c${i}`, i)));
    expect(saveConversation(s, convo("n", 10), 0).conversations).toHaveLength(6);
  });

  it("keeps activeId when the active conversation is archived and beyond the unarchived cap", () => {
    const s = stateOf([convo("a", 1, { archivedAt: 5 }), convo("b", 3), convo("c", 2)], "a");
    expect(saveConversation(s, convo("d", 9), 1).activeId).toBe("a");
  });
});

describe("setDistilledNote", () => {
  it("records the note path", () => {
    const next = setDistilledNote(stateOf([convo("a", 1)]), "a", "Claude/Chats/x.md");
    expect(next.conversations[0]?.distilledNote).toBe("Claude/Chats/x.md");
  });
});

describe("forkConversation", () => {
  it("copies messages and project, drops turn state, and links the source", () => {
    const source = convo("a", 5, {
      title: "Plan",
      projectId: "Projects/P.md",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "dead", contextExcluded: true },
      ],
      cliSessionId: "cli-1",
      cliSessionHistory: ["cli-0"],
      activeTurn: { id: "t", state: "failed", backend: "claude", model: "m", mode: "ask", userMessageIndex: 0, createdAt: 1, updatedAt: 1 },
      lastEditProposal: { path: "A.md", edits: [{ old_str: "a", new_str: "b" }], proposedAt: 1 },
      archivedAt: 3,
      distilledNote: "Claude/Chats/x.md",
    });
    const { state, fork } = forkConversation(stateOf([source], "a"), "a", "f1", 100);
    expect(fork.id).toBe("f1");
    expect(fork.title).toBe("Fork of Plan");
    expect(fork.forkedFrom).toBe("a");
    expect(fork.createdAt).toBe(100);
    expect(fork.updatedAt).toBe(100);
    expect(fork.projectId).toBe("Projects/P.md");
    expect(fork.messages.map((m) => m.content)).toEqual(["one", "two"]);
    for (const key of ["activeTurn", "lastEditProposal", "cliSessionId", "cliSessionHistory", "archivedAt", "distilledNote"]) {
      expect(key in fork).toBe(false);
    }
    expect(state.conversations.map((c) => c.id)).toContain("f1");
    expect(state.conversations.map((c) => c.id)).toContain("a");
    expect(state.activeId).toBe("a");
  });

  it("throws for an unknown id", () => {
    expect(() => forkConversation(stateOf([]), "nope", "f", 1)).toThrow(/nope/);
  });
});

describe("seededConversation", () => {
  it("builds a one-message conversation", () => {
    const seed = { role: "user" as const, content: "body", display: "Continuing from: X" };
    const c = seededConversation("s1", 50, "Fork of X", seed, "P.md");
    expect(c).toMatchObject({ id: "s1", title: "Fork of X", createdAt: 50, updatedAt: 50, projectId: "P.md", messages: [seed] });
    expect("projectId" in seededConversation("s2", 1, "t", seed)).toBe(false);
  });
});

describe("fromPersisted new fields", () => {
  it("round-trips well-typed fields", () => {
    const raw = { conversations: [convo("a", 1, { archivedAt: 7, distilledNote: "n.md", forkedFrom: "z" })], activeId: "a" };
    const c = fromPersisted(raw).conversations[0]!;
    expect(c.archivedAt).toBe(7);
    expect(c.distilledNote).toBe("n.md");
    expect(c.forkedFrom).toBe("z");
  });

  it("drops malformed fields", () => {
    const bad = { ...convo("a", 1), archivedAt: "yes", distilledNote: 4, forkedFrom: "" } as unknown;
    const c = fromPersisted({ conversations: [bad], activeId: "a" }).conversations[0]!;
    expect("archivedAt" in c).toBe(false);
    expect("distilledNote" in c).toBe(false);
    expect("forkedFrom" in c).toBe(false);
    const nan = { ...convo("b", 1), archivedAt: Number.NaN } as unknown;
    expect("archivedAt" in fromPersisted({ conversations: [nan] }).conversations[0]!).toBe(false);
  });
});
