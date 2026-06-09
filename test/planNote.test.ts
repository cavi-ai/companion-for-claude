import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { savePlanNote } from "../src/artifacts/artifactStore";
import { extractTasks } from "../src/build/spec";

const reply = [
  "```claude-html",
  "<!DOCTYPE html><html><head><title>Vault Optimization</title></head><body><h1>Plan</h1></body></html>",
  "```",
  "",
  "## Build tasks",
  "- [ ] Add frontmatter to untitled notes",
  "- [ ] Rename ambiguous notes",
  "- [ ] Archive orphans older than 180 days",
].join("\n");

describe("savePlanNote", () => {
  it("writes a type: plan note whose checklist the Build command can parse", async () => {
    const app = new App();
    const file = await savePlanNote(app, "Claude/Plans", "Vault Optimization", reply, {});
    const md = await app.vault.cachedRead(file);

    expect(file.path.startsWith("Claude/Plans/")).toBe(true);
    expect(md).toContain("type: plan"); // canonical → gets the Build icon
    expect(md).toContain("```claude-html"); // artifact preserved (renders inline)

    // The note is build-ready: extractTasks finds the checklist (not the HTML).
    const tasks = extractTasks(md);
    expect(tasks.map((t) => t.title)).toEqual([
      "Add frontmatter to untitled notes",
      "Rename ambiguous notes",
      "Archive orphans older than 180 days",
    ]);
  });
});
