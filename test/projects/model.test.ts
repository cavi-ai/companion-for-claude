import { describe, it, expect } from "vitest";
import { parseProjectNote, fromResearchProject, projectSystemPrompt, projectSearchScope, projectNoteBody, isProjectChange } from "../../src/projects/model";
import type { ResearchProjectRecord } from "../../src/research/types";

describe("parseProjectNote", () => {
  it("parses full frontmatter: folder, pinned notes, instructions body", () => {
    const project = parseProjectNote(
      "Claude/Projects/Launch.md",
      { type: "chat-project", folder: "Work/Launch", pinned: ["Work/Launch/Brief.md", "[[Work/Launch/Spec]]"] },
      "Ship the launch plan by Friday.\n",
    );
    expect(project).toEqual({
      id: "Claude/Projects/Launch.md",
      name: "Launch",
      folder: "Work/Launch",
      pinned: ["Work/Launch/Brief.md", "Work/Launch/Spec.md"],
      instructions: "Ship the launch plan by Friday.",
      source: "note",
    });
  });

  it("defaults folder to null and pinned to [] when missing", () => {
    const project = parseProjectNote("Claude/Projects/Solo.md", { type: "chat-project" }, "Just help with this one.");
    expect(project).toMatchObject({ folder: null, pinned: [], instructions: "Just help with this one." });
  });

  it("returns null for a note that isn't a chat-project", () => {
    expect(parseProjectNote("Notes/Regular.md", { type: "other" }, "body")).toBeNull();
    expect(parseProjectNote("Notes/Regular.md", undefined, "body")).toBeNull();
  });
});

describe("fromResearchProject", () => {
  it("maps title/question/folder from the research project record", () => {
    const record: ResearchProjectRecord = {
      path: "Research/AI Reviews/Project.md",
      title: "AI Reviews",
      type: "research-project",
      project: "Research/AI Reviews/Project.md",
      question: "How reliable are automated reviews?",
      stage: "frame",
      status: "active",
    };
    expect(fromResearchProject(record)).toEqual({
      id: "Research/AI Reviews/Project.md",
      name: "AI Reviews",
      folder: "Research/AI Reviews",
      pinned: [],
      instructions: "How reliable are automated reviews?",
      source: "research",
    });
  });
});

describe("projectSystemPrompt", () => {
  it("renders a header, the instructions, and pinned notes", () => {
    const prompt = projectSystemPrompt({
      id: "p.md", name: "Launch", folder: "Work/Launch", pinned: ["Work/Launch/Brief.md"], instructions: "Ship it.", source: "note",
    });
    expect(prompt).toBe("Chat project: Launch\n\nShip it.\n\nPinned notes:\n- Work/Launch/Brief.md");
  });

  it("omits the pinned section when there are no pinned notes", () => {
    const prompt = projectSystemPrompt({ id: "p.md", name: "Solo", folder: null, pinned: [], instructions: "Help.", source: "note" });
    expect(prompt).toBe("Chat project: Solo\n\nHelp.");
  });
});

describe("projectSearchScope", () => {
  it("accepts paths under the project's folder and rejects everything else", () => {
    const scope = projectSearchScope({ id: "p.md", name: "P", folder: "folder", pinned: [], instructions: "", source: "note" });
    expect(scope("folder/x.md")).toBe(true);
    expect(scope("other/x.md")).toBe(false);
    expect(scope("folderX/x.md")).toBe(false);
  });

  it("accepts everything when the project has no folder", () => {
    const scope = projectSearchScope({ id: "p.md", name: "P", folder: null, pinned: [], instructions: "", source: "note" });
    expect(scope("anything/x.md")).toBe(true);
  });
});

describe("projectNoteBody", () => {
  it("omits folder when null", () => {
    expect(projectNoteBody(null)).toBe("---\ntype: chat-project\n---\n\n");
  });

  it("omits folder when root ('/')", () => {
    expect(projectNoteBody("/")).toBe("---\ntype: chat-project\n---\n\n");
  });

  it("writes a JSON-quoted folder when a folder contains ': '", () => {
    expect(projectNoteBody("Work: Launch")).toBe('---\ntype: chat-project\nfolder: "Work: Launch"\n---\n\n');
  });
});

describe("isProjectChange", () => {
  it("is true for a chat-project note's frontmatter", () => {
    expect(isProjectChange("Notes/Launch.md", { type: "chat-project" })).toBe(true);
  });

  it("is true for a research project's Project.md path, regardless of frontmatter", () => {
    expect(isProjectChange("Research/Proj/Project.md", undefined)).toBe(true);
  });

  it("is false for an unrelated note", () => {
    expect(isProjectChange("Notes/Alpha.md", { type: "daily" })).toBe(false);
    expect(isProjectChange("Notes/Alpha.md", undefined)).toBe(false);
  });
});
