import { describe, it, expect } from "vitest";
import { closesFence, fencedLines, fenceOpen } from "../../src/markdown/fences";

const flags = (text: string): boolean[] => fencedLines(text.split("\n"));

describe("fenceOpen / closesFence", () => {
  it("opens on backtick and tilde runs of three or more, with an info string", () => {
    expect(fenceOpen("```bash")).toMatchObject({ char: "`", length: 3, depth: 0, column: 0, indent: 0 });
    expect(fenceOpen("~~~~")).toMatchObject({ char: "~", length: 4 });
    expect(fenceOpen("``")).toBeNull();
    expect(fenceOpen("text ```")).toBeNull();
  });

  it("opens behind indentation, blockquote markers, and list markers", () => {
    expect(fenceOpen("  ```bash")).toMatchObject({ char: "`", length: 3, column: 2, indent: 2 });
    expect(fenceOpen("> ```")).toMatchObject({ char: "`", length: 3, depth: 1 });
    expect(fenceOpen("> > ~~~")).toMatchObject({ char: "~", length: 3, depth: 2 });
    expect(fenceOpen("- ```js")).toMatchObject({ char: "`", length: 3, column: 2, indent: 0 });
    expect(fenceOpen("12. ```")).toMatchObject({ char: "`", length: 3, column: 4, indent: 0 });
  });

  it("does not open on a backtick run whose info string carries a backtick (inline code)", () => {
    expect(fenceOpen("```inline``` code")).toBeNull();
    expect(fenceOpen("~~~ has ` tick")).toMatchObject({ char: "~", length: 3 });
  });

  it("closes only on the same character at least as long, with nothing after it", () => {
    const open = fenceOpen("````")!;
    expect(closesFence("```", open)).toBe(false);
    expect(closesFence("````", open)).toBe(true);
    expect(closesFence("`````  ", open)).toBe(true);
    expect(closesFence("~~~~", open)).toBe(false);
    expect(closesFence("```` js", open)).toBe(false);
    expect(closesFence("> ````\r", fenceOpen("> ````")!)).toBe(true);
  });

  it("closes only in the opener's blockquote depth, without a list marker, at most three columns right", () => {
    const open = fenceOpen("```")!;
    expect(closesFence("> ```", open)).toBe(false);
    expect(closesFence("- ```", open)).toBe(false);
    expect(closesFence("   ```", open)).toBe(true);
    expect(closesFence("    ```", open)).toBe(false);
    expect(closesFence("  ```", fenceOpen("- ```js")!)).toBe(true);
  });
});

describe("fencedLines", () => {
  it("flags fence lines and everything between them", () => {
    expect(flags("a\n```\ncode\n```\nb")).toEqual([false, true, true, true, false]);
  });

  it("keeps an inner shorter fence inside a longer one", () => {
    expect(flags("````md\n```\ninner\n```\nstill code\n````\nprose")).toEqual([true, true, true, true, true, true, false]);
  });

  it("does not let a tilde line close a backtick fence", () => {
    expect(flags("```\n~~~\ncode\n```\nprose")).toEqual([true, true, true, true, false]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(flags("prose\n```\ncode\nmore")).toEqual([false, true, true, true]);
  });

  it("keeps quoted or list-marked fence lines inside an unprefixed fence as code", () => {
    expect(flags("```\n- ```\ncode\n```\nprose")).toEqual([true, true, true, true, false]);
    expect(flags("```\n> ```\ncode\n```\nprose")).toEqual([true, true, true, true, false]);
    expect(flags("```\n1. ```\ncode\n```\nprose")).toEqual([true, true, true, true, false]);
  });

  it("ends a quoted fence where the blockquote ends", () => {
    expect(flags("> ```\n> code\n\nprose\n```")).toEqual([true, true, false, false, true]);
    expect(flags("> > ```\n> > code\n> prose")).toEqual([true, true, false]);
  });

  it("treats an unclosed fence indented four or more columns as indented code, not a fence", () => {
    expect(flags("Syntax:\n\n    ```python\n\nprose")).toEqual([false, false, false, false, false]);
    expect(flags("\t```\nprose")).toEqual([false, false]);
    expect(flags("- a\n    - b\n      ```js\n      code\n      ```\nprose")).toEqual([false, false, true, true, true, false]);
    expect(flags("    ```\n    code\n    ```\nprose")).toEqual([true, true, true, false]);
  });

  it("covers fences inside list items and callouts", () => {
    expect(flags("- step:\n  ```bash\n  kubectl apply\n  ```\n- next")).toEqual([false, true, true, true, false]);
    expect(flags("> [!note]\n> ```\n> code\n> ```\n> prose")).toEqual([false, true, true, true, false]);
  });
});
