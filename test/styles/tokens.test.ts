import { describe, expect, it } from "vitest";
import { readStyles } from "./css";

describe("CSS token references", () => {
  it("declares every Companion token used without a fallback", () => {
    const css = readStyles();
    const declared = new Set([...css.matchAll(/(--cc-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const required = [...css.matchAll(/var\((--cc-[a-z0-9-]+)\s*\)/g)].map((match) => match[1]);
    expect([...new Set(required)].filter((name) => !declared.has(name))).toEqual([]);
  });
});
