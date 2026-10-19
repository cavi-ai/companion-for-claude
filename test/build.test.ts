import { describe, it, expect } from "vitest";
import { extractTasks, isPlanReply, specBody, type SpecInput } from "../src/build/spec";
import { trackerNoteBody } from "../src/build/tracker";
import { createBuildRun } from "../src/build/run";

describe("isPlanReply", () => {
  it.each([
    ["## Build tasks\n- [ ] Create the parser", true],
    ["### BUILD TASKS ###\r\n* [X] Create the parser", true],
    ["## Build tasks\n- Create the parser", false],
    ["## Build tasks\n\n## Findings\n- [ ] Read the report", false],
    ["~~~markdown\n## Build tasks\n- [ ] Create the parser\n~~~", false],
    ["## Build tasks\n```markdown\n- [ ] Example task\n```", false],
    ["> ## Build tasks\n> - [ ] Create the parser", false],
    ["    ## Build tasks\n    - [ ] Create the parser", false],
  ])("recognizes explicit checklist intent in %j", (reply, expected) => {
    expect(isPlanReply(reply)).toBe(expected);
  });
});

describe("extractTasks", () => {
  it.each([
    ["- [ ] Ship formatter\n```markdown\n- [ ] Example item\n```", [{ title: "Ship formatter", done: false }]],
    ["~~~markdown\n- [x] Example item\n~~~\n- [x] Review design\n- [ ] Ship formatter", [{ title: "Review design", done: true }, { title: "Ship formatter", done: false }]],
    ["````markdown\n```\n- [ ] Example item\n```\n````\n- [ ] Ship formatter", [{ title: "Ship formatter", done: false }]],
    ["```markdown\n- [ ] Example item\n```", []],
    ["- [ ] Ship formatter\n~~~markdown\n- [ ] Unclosed example", [{ title: "Ship formatter", done: false }]],
    ["1. Ship formatter\n```markdown\n- [ ] Example checkbox\n```", [{ title: "Ship formatter", done: false }]],
    ["~~~text\n1. Example milestone\n~~~\n1. Ship formatter", [{ title: "Ship formatter", done: false }]],
    ["---\nexample: |\n  - [ ] Metadata example\n---\n- [ ] Ship formatter", [{ title: "Ship formatter", done: false }]],
  ])("extracts work from prose rather than examples in %j", (plan, expected) => {
    expect(extractTasks(plan as string)).toEqual(expected);
  });

  it("retains real nested checklist items and their done state", () => {
    expect(extractTasks("- [ ] Parent\n    - [x] Child")).toEqual([{ title: "Parent", done: false }, { title: "Child", done: true }]);
  });

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
