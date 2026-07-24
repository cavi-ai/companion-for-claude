import { describe, expect, it } from "vitest";
import { inferResearchProjectPath, isResearchProjectChange, projectPathForActivation, resolveResearchProjectLink } from "../../src/research/workbenchRouting";

describe("research workbench routing", () => {
  it("resolves canonical plain and aliased project wikilinks", () => {
    expect(resolveResearchProjectLink("[[Research\\Alpha/Project.md]]")).toBe("Research/Alpha/Project.md");
    expect(resolveResearchProjectLink("[[Research/Alpha/Project|Alpha]]")).toBe("Research/Alpha/Project.md");
    expect(resolveResearchProjectLink("Research/Alpha/Notes.md")).toBeUndefined();
  });

  it("resolves project notes and canonically linked research records", () => {
    expect(inferResearchProjectPath("Research/Alpha/Project.md", { type: "research-project" }))
      .toBe("Research/Alpha/Project.md");
    for (const type of ["research-source", "evidence", "claim", "research-question", "research-document"]) {
      expect(inferResearchProjectPath("Anywhere/Record.md", {
        type,
        project: "[[Research/Alpha/Project.md|Alpha]]",
      })).toBe("Research/Alpha/Project.md");
    }
  });

  it("does not guess an owning project from folders or unrelated metadata", () => {
    expect(inferResearchProjectPath("Research/Alpha/Evidence/E1.md", {})).toBeUndefined();
    expect(inferResearchProjectPath("Research/Alpha/Evidence/E1.md", { type: "ordinary-note", project: "Research/Alpha/Project.md" })).toBeUndefined();
    expect(inferResearchProjectPath("Research/Alpha/Evidence/E1.md", { type: "evidence", project: "Elsewhere.md" })).toBeUndefined();
    expect(inferResearchProjectPath("Research/Alpha/Project.md", { type: "research-project", project: "Elsewhere.md" })).toBe("Research/Alpha/Project.md");
  });

  it("preserves the selected project when activation has no new project", () => {
    expect(projectPathForActivation(undefined, undefined, "Research/Selected/Project.md")).toBe("Research/Selected/Project.md");
    expect(projectPathForActivation("[[Research/Explicit/Project]]", "Research/Inferred/Project.md", "Research/Selected/Project.md")).toBe("Research/Explicit/Project.md");
  });

  it("routes damaged canonical records only to their current project", () => {
    const current = "Research/Alpha/Project.md";
    expect(isResearchProjectChange(current, "Research/Alpha/Project.md")).toBe(true);
    expect(isResearchProjectChange(current, "Research/Alpha/Sources/Damaged.md")).toBe(true);
    expect(isResearchProjectChange(current, "Research/Alpha/Evidence/Missing metadata.md")).toBe(true);
    expect(isResearchProjectChange(current, "Research/Beta/Claims/C1.md")).toBe(false);
  });

  it("considers both old and new paths during rename", () => {
    const current = "Research/Alpha/Project.md";
    expect(isResearchProjectChange(current, "Archive/E1.md", "Research/Alpha/Evidence/E1.md")).toBe(true);
    expect(isResearchProjectChange(current, "Research/Alpha/Questions/Q1.md", "Inbox/Q1.md")).toBe(true);
    expect(isResearchProjectChange(current, "Research/Beta/Evidence/E1.md", "Research/Beta/Evidence/Old.md")).toBe(false);
  });
});
