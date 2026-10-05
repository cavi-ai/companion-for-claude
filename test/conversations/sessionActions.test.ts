import { describe, expect, it, vi } from "vitest";
import { SessionActions, type SessionActionsDeps } from "../../src/conversations/sessionActions";
import type { Conversation } from "../../src/conversations/store";

const source: Conversation = { id: "a", title: "Plan", createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: "hi" }], projectId: "P.md" };

function harness(convo: Conversation | undefined, notes: Record<string, string> = {}, distillResult: string | null = null) {
  const calls: string[] = [];
  const deps: SessionActionsDeps = {
    find: () => convo,
    archive: vi.fn(async () => { calls.push("archive"); }),
    fork: vi.fn(async () => ({ ...source, id: "f1" })),
    createSeeded: vi.fn(async () => ({ ...source, id: "s1" })),
    distill: vi.fn(async () => { calls.push("distill"); return distillResult; }),
    readNote: vi.fn(async (path: string) => notes[path] ?? null),
    openInNewTab: vi.fn(async () => { calls.push("open"); }),
  };
  return { actions: new SessionActions(deps), deps, calls };
}

describe("SessionActions", () => {
  it("archive persists first, then distills; a failed distill leaves it archived", async () => {
    const h = harness(source, {}, null);
    await h.actions.archive("a");
    expect(h.calls).toEqual(["archive", "distill"]);
  });

  it("fork stores the copy and opens it in a new tab", async () => {
    const h = harness(source);
    await h.actions.fork("a");
    expect(h.deps.fork).toHaveBeenCalledWith("a");
    expect(h.deps.openInNewTab).toHaveBeenCalledWith("f1");
  });

  it("fork-from-summary seeds with the note body minus frontmatter, reusing an existing note", async () => {
    const h = harness({ ...source, distilledNote: "n.md" }, { "n.md": '---\ntitle: "Plan"\n---\n\n# Plan\n\n## Summary\n\nWe planned.\n' });
    await h.actions.forkFromSummary("a");
    expect(h.deps.distill).not.toHaveBeenCalled();
    const [title, seed, projectId] = vi.mocked(h.deps.createSeeded).mock.calls[0]!;
    expect(title).toBe("Fork of Plan");
    expect(seed).toEqual({ role: "user", display: "Continuing from: Plan", content: "# Plan\n\n## Summary\n\nWe planned." });
    expect(projectId).toBe("P.md");
    expect(h.deps.openInNewTab).toHaveBeenCalledWith("s1");
  });

  it("fork-from-summary distills first when the note is missing", async () => {
    const h = harness({ ...source, distilledNote: "gone.md" }, { "new.md": "# New\n" }, "new.md");
    await h.actions.forkFromSummary("a");
    expect(h.calls).toEqual(["distill", "open"]);
    expect(vi.mocked(h.deps.createSeeded).mock.calls[0]?.[1].content).toBe("# New");
  });

  it("fork-from-summary stores nothing and opens no tab when distill fails", async () => {
    const h = harness(source, {}, null);
    await h.actions.forkFromSummary("a");
    expect(h.deps.createSeeded).not.toHaveBeenCalled();
    expect(h.deps.openInNewTab).not.toHaveBeenCalled();
  });

  it("unknown conversations are a no-op", async () => {
    const h = harness(undefined);
    await h.actions.fork("x");
    await h.actions.forkFromSummary("x");
    expect(h.deps.fork).not.toHaveBeenCalled();
    expect(h.deps.distill).not.toHaveBeenCalled();
  });
});
