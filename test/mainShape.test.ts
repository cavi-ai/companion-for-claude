import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const lines = (rel: string): number => readFileSync(resolve(__dirname, "../src", rel), "utf8").split("\n").length;

describe("plugin entry shape", () => {
  it("main.ts stays at or under 1200 lines", () => {
    expect(lines("main.ts")).toBeLessThanOrEqual(1200);
  });
});
