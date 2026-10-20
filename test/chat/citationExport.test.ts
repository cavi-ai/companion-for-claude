import { describe, expect, it } from "vitest";
import { exportCitationLinks, type CitationTarget } from "../../src/chat/provenance";

describe("exported citation links", () => {
  const targets: CitationTarget[] = [
    { linkpath: "Notes/Alpha.md", heading: "Findings", path: "Archive/Migration.md" },
    { linkpath: "Alpha", heading: null, path: "Archive/Migration.md" },
    { linkpath: "Missing", heading: null, path: null },
  ];
  it("uses current full paths and retains headings, block anchors, aliases, and repeated links", () => {
    expect(exportCitationLinks("See [[Notes/Alpha.md#Findings|findings]], [[Alpha]], [[Alpha#^block]] and [[Alpha]].", targets)).toBe(
      "See [[Archive/Migration.md#Findings|findings]], [[Archive/Migration.md]], [[Archive/Migration.md#^block]] and [[Archive/Migration.md]].",
    );
  });
  it("disarms unavailable sources without turning their labels into Markdown", () => {
    expect(exportCitationLinks("[[Missing]]; [[Missing|<tag>*label*]]; [[#Local]]", targets)).toBe("Missing (source unavailable); \\<tag\\>\\*label\\* (source unavailable); [[#Local]]");
  });
  it("preserves code, embeds, unrelated links, and original offsets", () => {
    const code = ["`[[Alpha]]` and `` `[[Alpha]]` ``", "````md", "[[Alpha]]", "```", "[[Alpha]]", "````", "~~~md", "[[Alpha]]", "~~~", "![[Alpha]] and [[Other]]"].join("\n");
    expect(exportCitationLinks(`${code}\n[[Alpha]]`, targets)).toBe(`${code}\n[[Archive/Migration.md]]`);
  });
  it("does not alter untracked references or the supplied target metadata", () => {
    const before = JSON.stringify(targets);
    expect(exportCitationLinks("[[Untracked]]", targets)).toBe("[[Untracked]]");
    expect(JSON.stringify(targets)).toBe(before);
  });
  it("follows the parser's case-insensitive identity for repeated citations", () => {
    expect(exportCitationLinks("[[ALPHA]] and [[notes/alpha.md#findings]]", targets)).toBe("[[Archive/Migration.md]] and [[Archive/Migration.md#findings]]");
  });
});
