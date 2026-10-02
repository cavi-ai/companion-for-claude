import { describe, it, expect } from "vitest";
import { readStyles } from "./tokens.test";

describe("stylesheet browser compatibility", () => {
  it("does not use display: contents (flagged by the community release scan as partially supported)", () => {
    expect(readStyles()).not.toMatch(/display\s*:\s*contents/);
  });

  it("lays the borrowed chat-header controls out as a non-growing flex row", () => {
    const css = readStyles();
    const rule = /\.cc-header-actions \.cc-companion-chrome-controls \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex:\s*0 1 auto/);
  });
});
