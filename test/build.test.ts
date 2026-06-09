import { describe, it, expect } from "vitest";
import { extractTasks, specBody, buildPrompt, claudeCodeBuildCommand, type SpecInput } from "../src/build/spec";
import { trackerArtifact } from "../src/build/tracker";

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

describe("buildPrompt / claudeCodeBuildCommand", () => {
  it("drives the build through the MCP note tools, not a phantom CLI", () => {
    const p = buildPrompt(input);
    expect(p).toContain("MCP server");
    expect(p).toContain("note_read");
    expect(p).toContain(`path = "${input.specPath}"`);
    expect(p).toContain("note_append");
    expect(p).toContain(`path = "${input.trackerPath}"`);
    expect(p).not.toContain("obsidian read"); // no non-existent CLI
    expect(p).not.toContain("obsidian append");
  });
  it("double-quote wraps and escapes the prompt for -p", () => {
    const cmd = claudeCodeBuildCommand(input);
    expect(cmd.startsWith('claude -p "')).toBe(true);
    expect(cmd.endsWith('"')).toBe(true);
    expect(cmd).toContain("\\`note_read\\`"); // backticks escaped for the shell
  });
  it("escapes backslashes before double quotes in the -p argument", () => {
    const cmd = claudeCodeBuildCommand({
      ...input,
      specPath: String.raw`Claude\Builds\bad\"path.md`,
    });
    expect(cmd).toContain(String.raw`path = \"Claude\\Builds\\bad\\\"path.md\"`);
  });
  it("neutralizes shell-injection chars in user-controlled fields", () => {
    const evil = claudeCodeBuildCommand({ ...input, title: 'x"; rm -rf ~ #$(whoami)`id`' });
    const inner = evil.slice('claude -p "'.length, -1);
    expect(inner).toContain('\\"; rm -rf ~ #\\$(whoami)\\`id\\`');
    expect(inner).not.toMatch(/(^|[^\\])"; rm -rf/);
  });
});

describe("trackerArtifact", () => {
  it("renders progress percentage and task rows", () => {
    const html = trackerArtifact("Comment threads", input.tasks);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("1 / 2 tasks · 50%");
    expect(html).toContain("width:50%");
    expect(html).toContain("Comment threads");
  });
  it("escapes HTML in task titles", () => {
    const html = trackerArtifact("X", [{ title: "<script>alert(1)</script>", done: false }]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("handles an empty task list without dividing by zero", () => {
    const html = trackerArtifact("Empty", []);
    expect(html).toContain("0 / 0 tasks · 0%");
  });
});
