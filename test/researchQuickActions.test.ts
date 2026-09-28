import { describe, it, expect } from "vitest";
import { researchQuickActions } from "../src/view/chat/researchQuickActions";
import type { ResearchDeskAction } from "../src/research/deskViewModel";

const action = (id: string, label: string, path?: string): ResearchDeskAction => ({
  id, label, reason: "Because.", target: "Sources", priority: 4, tone: "continue", ...(path ? { path } : {}),
});

const PROJECT = "Research/Alpha/Project.md";

describe("researchQuickActions", () => {
  it("caps the list at three actions", () => {
    const actions = ["a", "b", "c", "d", "e"].map((x) => action(`${x}:p`, x));
    expect(researchQuickActions(actions, PROJECT)).toHaveLength(3);
  });

  it("pipeline steps map to their research tools", () => {
    const prompts = new Map(researchQuickActions([
      action("add-source:p", "s"),
      action("create-evidence:p", "e"),
      action("create-claim:p", "c"),
    ], PROJECT).map((qa) => [qa.label, qa.prompt]));
    expect(prompts.get("s")).toContain("research_source_import");
    expect(prompts.get("e")).toContain("research_evidence_capture");
    expect(prompts.get("c")).toContain("research_claim_create");
  });

  it("audit findings reference the audit tool, the label, and the record path", () => {
    const [qa] = researchQuickActions([action("stale-evidence:Research/Alpha/Evidence/E.md", "Re-check E", "Research/Alpha/Evidence/E.md")], PROJECT);
    expect(qa?.prompt).toContain("research_audit");
    expect(qa?.prompt).toContain("Re-check E");
    expect(qa?.prompt).toContain("Research/Alpha/Evidence/E.md");
  });

  it("every prompt names the project path", () => {
    for (const qa of researchQuickActions([action("unknown-kind:p", "Mystery")], PROJECT)) {
      expect(qa.prompt).toContain(PROJECT);
    }
  });
});
