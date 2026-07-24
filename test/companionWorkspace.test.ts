import { describe, expect, it } from "vitest";
import { resolveCompanionWorkspace } from "../src/view/companionWorkspace";

describe("resolveCompanionWorkspace", () => {
  it("prioritizes the active research project and its next action", () => {
    expect(resolveCompanionWorkspace({
      activeNote: { path: "Research/Alpha/Claims/Claim.md", title: "Claim" },
      research: {
        projectPath: "Research/Alpha/Project.md",
        title: "Alpha",
        stage: "drafting",
        nextAction: "Assure the current draft",
        nextReason: "Check grounding before revision.",
      },
    })).toEqual({
      kind: "research",
      eyebrow: "CURRENT WORKSPACE · RESEARCH",
      title: "Continue Alpha",
      description: "Check grounding before revision.",
      meta: "Drafting · Assure the current draft",
      primaryAction: "Open Research Desk",
      secondaryAction: "Ask Companion",
      contextPath: "Research/Alpha/Project.md",
    });
  });

  it("uses the active note without promoting unrelated research projects", () => {
    expect(resolveCompanionWorkspace({
      activeNote: { path: "Writing/Essay.md", title: "Essay" },
    })).toEqual({
      kind: "note",
      eyebrow: "CURRENT WORKSPACE · NOTE",
      title: "Continue with Essay",
      description: "Bring this note into the conversation or rediscover related material without leaving your train of thought.",
      meta: "Writing/Essay.md",
      primaryAction: "Ask about this note",
      secondaryAction: "Find related notes",
      contextPath: "Writing/Essay.md",
    });
  });

  it("returns no workspace when there is no active note", () => {
    expect(resolveCompanionWorkspace({})).toBeNull();
  });
});
