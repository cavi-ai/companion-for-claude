import { describe, it, expect } from "vitest";
import { replaceSection } from "../src/mcp/edit";

describe("replaceSection", () => {
  const md = "# Title\n\n## Tasks\nold a\nold b\n\n## Notes\nkeep\n";

  it("replaces a section body up to the next same-level heading", () => {
    expect(replaceSection(md, "Tasks", "new content")).toBe(
      "# Title\n\n## Tasks\n\nnew content\n\n## Notes\nkeep\n",
    );
  });

  it("matches headings case-insensitively and ignores surrounding whitespace", () => {
    expect(replaceSection(md, "  tasks ", "x")).toContain("## Tasks\n\nx\n");
  });

  it("replaces the final section through end-of-file", () => {
    expect(replaceSection(md, "Notes", "done")).toBe(
      "# Title\n\n## Tasks\nold a\nold b\n\n## Notes\n\ndone\n",
    );
  });

  it("throws when the heading is absent", () => {
    expect(() => replaceSection(md, "Missing", "x")).toThrow(/Section not found/);
  });

  it("does not treat '#' lines inside a fenced code block as section boundaries", () => {
    const fenced = [
      "# Title",
      "",
      "## Tasks",
      "```bash",
      "# inside fence",
      "echo hi",
      "```",
      "",
      "## Notes",
      "keep",
      "",
    ].join("\n");
    const out = replaceSection(fenced, "Tasks", "replaced");
    // The in-fence comment line must be consumed by the Tasks section, not left dangling.
    expect(out).not.toContain("# inside fence");
    expect(out).toContain("## Tasks\n\nreplaced\n");
    // The real following section is preserved.
    expect(out).toContain("## Notes\nkeep");
  });

  it("matches a closed-ATX heading (## Foo ##)", () => {
    const closed = "## Foo ##\nbody\n";
    expect(replaceSection(closed, "Foo", "new")).toBe("## Foo ##\n\nnew\n");
  });
});
