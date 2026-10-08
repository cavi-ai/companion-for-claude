import { describe, expect, it } from "vitest";
import { transformNoteForPublish } from "../../src/publish/noteTransform";

describe("transformNoteForPublish", () => {
  it("strips frontmatter", () => {
    expect(transformNoteForPublish("---\ntitle: x\nsecret: y\n---\n# Hi\n\nbody\n")).toBe("# Hi\n\nbody\n");
  });

  it("strips an empty frontmatter block and CRLF frontmatter", () => {
    expect(transformNoteForPublish("---\n---\nbody")).toBe("body\n");
    expect(transformNoteForPublish("---\r\na: 1\r\n---\r\nbody")).toBe("body\n");
  });

  it("keeps the body between an empty frontmatter block and a later horizontal rule", () => {
    expect(transformNoteForPublish("---\n---\nIntro paragraph.\n\n---\n\nSection two.\n")).toBe("Intro paragraph.\n\n---\n\nSection two.\n");
  });

  it("leaves wikilinks inside a fenced code block in a list item alone", () => {
    expect(transformNoteForPublish("- step:\n  ```md\n  [[Secret Note]]\n  ```\n")).toBe("- step:\n  ```md\n  [[Secret Note]]\n  ```\n");
  });

  it("keeps code and drops comments around list-marked or quoted fence lines inside a fence", () => {
    expect(transformNoteForPublish("```\n- ```\ncode [[X]]\n```\n%% after %%\n")).toBe("```\n- ```\ncode [[X]]\n```\n");
    expect(transformNoteForPublish("```markdown\n> ```\ncode [[X]]\n```\n%% after %%\n")).toBe("```markdown\n> ```\ncode [[X]]\n```\n");
  });

  it("does not treat an unclosed indented ``` as a fence", () => {
    expect(transformNoteForPublish("Syntax reference:\n\n    ```python\n\n%% private %%\nSee [[Budget]]\n")).toBe("Syntax reference:\n\n    ```python\n\n\nSee Budget\n");
  });

  it("keeps a horizontal rule that is not frontmatter", () => {
    expect(transformNoteForPublish("intro\n\n---\n\nafter")).toBe("intro\n\n---\n\nafter\n");
  });

  it("removes inline %% comments", () => {
    expect(transformNoteForPublish("a %%private%% b")).toBe("a  b\n");
  });

  it("removes multi-line %% comments", () => {
    expect(transformNoteForPublish("before\n%%\nsecret one\nsecret two\n%%\nafter")).toBe("before\n\nafter\n");
  });

  it("removes an unclosed %% comment through the end of the note", () => {
    expect(transformNoteForPublish("keep\n%% never closed\nleak?")).toBe("keep\n");
  });

  it("leaves %% inside a fenced code block alone", () => {
    const note = "```js\nconst a = '%%not a comment%%';\n```\ntext %%gone%%";
    expect(transformNoteForPublish(note)).toBe("```js\nconst a = '%%not a comment%%';\n```\ntext\n");
  });

  it("leaves %% inside a tilde fence and inline code alone", () => {
    expect(transformNoteForPublish("~~~\n%%x%%\n~~~\nuse `%%` here and `%%` there")).toBe("~~~\n%%x%%\n~~~\nuse `%%` here and `%%` there\n");
  });

  it("does not treat a fence inside a comment as code", () => {
    expect(transformNoteForPublish("%%\n```\nsecret\n```\n%%\nok")).toBe("ok\n");
  });

  it("flattens wikilinks", () => {
    expect(transformNoteForPublish("[[a|shown]] [[b#Heading]] [[c]] [[d#h|label]]")).toBe("shown b c label\n");
  });

  it("replaces vault embeds with a placeholder", () => {
    expect(transformNoteForPublish("![[diagram.png]] and ![[Other note|200]]")).toBe("*(diagram.png — not published)* and *(Other note — not published)*\n");
  });

  it("replaces markdown images that point into the vault", () => {
    expect(transformNoteForPublish("![alt](attachments/pic.png) ![](<my pics/a b.png>)")).toBe("*(pic.png — not published)* *(a b.png — not published)*\n");
  });

  it("keeps http(s) and data images", () => {
    const note = "![a](https://example.com/x.png) ![b](http://example.com/y.png) ![c](data:image/png;base64,AAAA)";
    expect(transformNoteForPublish(note)).toBe(`${note}\n`);
  });

  it("keeps ordinary markdown, links, and code", () => {
    const note = "# T\n\n- [x] done\n[link](https://a.b)\n\n```\n[[not a link]]\n```\n";
    expect(transformNoteForPublish(note)).toBe(note);
  });

  it("returns an empty string when only frontmatter and comments remain", () => {
    expect(transformNoteForPublish("---\na: 1\n---\n%%only a comment%%\n")).toBe("");
  });
});
