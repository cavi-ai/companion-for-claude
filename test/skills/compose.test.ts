import { describe, expect, it } from "vitest";
import { composeSkillPrompt, parseSkillInvocation, skillDisplay, SKILL_PREAMBLE } from "../../src/skills/compose";
import type { SkillEntry } from "../../src/workflows/skillRegistry.generated";

const rollup: SkillEntry = { id: "daily-rollup", name: "Daily rollup", description: "Recap", tier: "orchestrator", argHint: "[days, default 7]", body: "# Daily rollup\n\nDo the thing." };
const weaver: SkillEntry = { id: "wikilink-weaver", name: "Wikilink weaver", description: "Links", tier: "worker", argHint: "<note path>", body: "# Weaver" };
const skills = [rollup, weaver];

describe("parseSkillInvocation", () => {
  it("matches a bare id, an id with args, and multi-line args", () => {
    expect(parseSkillInvocation("/daily-rollup", skills)).toEqual({ entry: rollup, args: "" });
    expect(parseSkillInvocation("/daily-rollup 3", skills)).toEqual({ entry: rollup, args: "3" });
    expect(parseSkillInvocation("/wikilink-weaver Notes/A.md\nand B", skills)).toEqual({ entry: weaver, args: "Notes/A.md\nand B" });
  });
  it("ignores unknown ids and ordinary prose", () => {
    expect(parseSkillInvocation("/summarize", skills)).toBeNull();
    expect(parseSkillInvocation("run /daily-rollup", skills)).toBeNull();
    expect(parseSkillInvocation("/daily-rollup/extra", skills)).toBeNull();
  });
});

describe("composeSkillPrompt", () => {
  it("prefixes the preamble, names the skill, includes the body, and states the task", () => {
    const p = composeSkillPrompt(rollup, "3");
    expect(p.startsWith(SKILL_PREAMBLE.replace("{name}", "Daily rollup"))).toBe(true);
    expect(p).toContain("# Skill: Daily rollup");
    expect(p).toContain("Do the thing.");
    expect(p.endsWith("# Task\n\n3")).toBe(true);
  });
  it("without args, asks to run the skill and mentions the argument hint", () => {
    const p = composeSkillPrompt(rollup, "");
    expect(p.endsWith("# Task\n\nRun this skill now. It accepts: [days, default 7] — none were given, so use the default or ask.")).toBe(true);
    expect(composeSkillPrompt({ ...rollup, argHint: "" }, "").endsWith("# Task\n\nRun this skill now.")).toBe(true);
  });
  it("maps the obsidian CLI verbs onto Companion tools in the preamble", () => {
    for (const tool of ["vault_search", "note_read", "note_create", "note_append", "propose_note_edit", "note_patch"]) expect(SKILL_PREAMBLE).toContain(tool);
  });
});

describe("skillDisplay", () => {
  it("renders the command chip label", () => {
    expect(skillDisplay(rollup, "")).toBe("/daily-rollup");
    expect(skillDisplay(rollup, "3")).toBe("/daily-rollup 3");
  });
});
