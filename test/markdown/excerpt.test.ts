import { describe, expect, it } from "vitest";
import { noteExcerpt } from "../../src/markdown/excerpt";

describe("noteExcerpt", () => {
  it("drops frontmatter and fenced code and keeps prose", () => {
    const content = "---\ntitle: x\ntype: secret\n---\nHello   world\n\n```js\nconst key = 'sk-123';\n```\nAfter ~~~ text\n~~~\nhidden\n~~~\nTail";
    expect(noteExcerpt(content, 200)).toBe("Hello world After ~~~ text Tail");
  });

  it("strips Markdown punctuation and collapses whitespace", () => {
    expect(noteExcerpt("---\ntitle: X\n---\n\n# Heading\n\nSome **text** here, see [[Link]].\n\nMore.", 400)).toBe("Heading Some text here, see Link . More.");
  });

  it("an unclosed fence hides the rest; a tilde fence is not closed by backticks", () => {
    expect(noteExcerpt("intro\n```\nsecret", 200)).toBe("intro");
    expect(noteExcerpt("a\n~~~\nsecret\n```\nstill secret\n~~~\nb", 200)).toBe("a b");
  });

  it("clips by code point, not by UTF-16 unit", () => {
    const out = noteExcerpt("🧠".repeat(500), 200);
    expect(Array.from(out)).toHaveLength(200);
  });

  it("handles no frontmatter, empty frontmatter, CRLF, BOM, and empty notes", () => {
    expect(noteExcerpt("Plain Café 2024", 200)).toBe("Plain Café 2024");
    expect(noteExcerpt("---\n---\nBody", 200)).toBe("Body");
    expect(noteExcerpt("---\r\ntype: x\r\n---\r\nBody", 200)).toBe("Body");
    expect(noteExcerpt(`${String.fromCharCode(0xfeff)}---\ntype: x\n---\nBody`, 200)).toBe("Body");
    expect(noteExcerpt("", 200)).toBe("");
  });
});
