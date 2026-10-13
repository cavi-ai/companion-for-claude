import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(__dirname, "../../src");
const lines = (path: string): number => readFileSync(path, "utf8").split("\n").length;
const items = readdirSync(resolve(src, "settingsItems")).filter((f) => f.endsWith(".ts"));

describe("settings tab carve shape", () => {
  it("settings.ts stays at or under 400 lines", () => {
    expect(lines(resolve(src, "settings.ts"))).toBeLessThanOrEqual(400);
  });

  it.each(items)("settingsItems/%s stays at or under 300 lines", (file) => {
    expect(lines(resolve(src, "settingsItems", file))).toBeLessThanOrEqual(300);
  });
});
