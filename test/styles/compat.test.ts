import { describe, it, expect } from "vitest";
import { readStyles } from "./css";

describe("stylesheet browser compatibility", () => {
  it("does not use display: contents (flagged by the community release scan as partially supported)", () => {
    expect(readStyles()).not.toMatch(/display\s*:\s*contents/);
  });

});
