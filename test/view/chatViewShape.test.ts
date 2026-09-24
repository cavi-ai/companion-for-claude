import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const lines = (rel: string): number => readFileSync(resolve(__dirname, "../../src/view", rel), "utf8").split("\n").length;

describe("ChatView carve shape", () => {
  it.each(["chat/Composer.ts", "chat/HeaderControls.ts", "chat/Transcript.ts"])("%s stays at or under 700 lines", (rel) => {
    expect(lines(rel)).toBeLessThanOrEqual(700);
  });

  it("ChatView.ts stays at or under 1500 lines", () => {
    expect(lines("ChatView.ts")).toBeLessThanOrEqual(1500);
  });
});
