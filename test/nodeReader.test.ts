import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verifies the desktop-only fs reader still works after being split out of
// sessions.ts (it's now lazy-imported behind Platform.isMobile). Confirms the
// module is dynamically importable and the reader logic is intact.
describe("nodeReader (desktop fs reader, post-split)", () => {
  it("is dynamically importable; defaultProjectsRoot points at ~/.claude/projects", async () => {
    const { defaultProjectsRoot } = await import("../src/memory/nodeReader");
    expect(defaultProjectsRoot()).toMatch(/[/\\]\.claude[/\\]projects$/);
  });

  it("nodeSessionReader lists only .jsonl (id strips ext) and reads content", async () => {
    const { nodeSessionReader } = await import("../src/memory/nodeReader");
    const dir = await mkdtemp(join(tmpdir(), "cc-nodereader-"));
    await writeFile(join(dir, "abc.jsonl"), '{"cwd":"/x"}', "utf8");
    await writeFile(join(dir, "note.txt"), "ignored", "utf8");

    const files = await nodeSessionReader.listFiles(dir);
    expect(files.map((f) => f.id)).toEqual(["abc"]);
    expect(files[0].path).toBe(join(dir, "abc.jsonl"));
    expect(await nodeSessionReader.read(files[0].path)).toBe('{"cwd":"/x"}');
  });

  it("missing project dir → [] (no throw)", async () => {
    const { nodeSessionReader } = await import("../src/memory/nodeReader");
    expect(await nodeSessionReader.listFiles(join(tmpdir(), "cc-does-not-exist-xyz"))).toEqual([]);
  });
});
