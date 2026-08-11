import { describe, it, expect } from "vitest";
import { extractTasks, specBody, type SpecInput } from "../src/build/spec";
import { trackerNoteBody } from "../src/build/tracker";
import { createBuildRun } from "../src/build/run";

describe("extractTasks", () => {
  it("reads markdown checkboxes with done state", () => {
    const tasks = extractTasks("- [ ] First\n- [x] Second done\n* [X] Third");
    expect(tasks).toEqual([
      { title: "First", done: false },
      { title: "Second done", done: true },
      { title: "Third", done: true },
    ]);
  });
  it("falls back to numbered/bulleted milestones (stripping HTML)", () => {
    const plan = "<ol><li>Build the parser</li></ol>\n1. Wire the UI\n- Ship it";
    const tasks = extractTasks(plan);
    expect(tasks.map((t) => t.title)).toContain("Wire the UI");
    expect(tasks.every((t) => !t.done)).toBe(true);
  });
  it("returns empty when nothing is task-like", () => {
    expect(extractTasks("just a paragraph of prose")).toEqual([]);
  });
});

const input: SpecInput = {
  title: "Comment threads",
  plan: "- [ ] A\n- [x] B",
  specPath: "Claude/Builds/Comment threads — spec.md",
  trackerPath: "Claude/Builds/Comment threads — tracker.md",
  vault: "My Vault",
  tasks: [
    { title: "A", done: false },
    { title: "B", done: true },
  ],
};

describe("specBody", () => {
  it("includes a checklist and the plan", () => {
    const body = specBody(input);
    expect(body).toContain("# Build spec: Comment threads");
    expect(body).toContain("- [ ] A");
    expect(body).toContain("- [x] B");
    expect(body).toContain("## Plan");
  });
});

describe("trackerNoteBody", () => {
  it("mirrors status, progress, task results, errors, and the cloud session without embedded CSS", () => {
    const run = createBuildRun({ id: "r", title: input.title, specPath: input.specPath, trackerPath: input.trackerPath, transport: "cloud", tasks: input.tasks, now: 1 });
    run.status = "failed";
    run.error = "Authentication failed";
    run.sessionUrl = "https://claude.ai/code/r";
    const markdown = trackerNoteBody(run);
    expect(markdown).toContain("**Status:** Needs attention");
    expect(markdown).toContain("1 / 2 tasks · 50%");
    expect(markdown).toContain("- [x] 2. B");
    expect(markdown).toContain("Authentication failed");
    expect(markdown).toContain("https://claude.ai/code/r");
    expect(markdown).not.toContain("<style>");
  });
});
