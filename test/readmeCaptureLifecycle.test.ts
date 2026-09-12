import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("README capture lifecycle", () => {
  it("launches one Obsidian session for the complete capture suite", async () => {
    const spec = await readFile(new URL("../e2e/readme-captures.spec.ts", import.meta.url), "utf8");
    expect(spec.match(/launchObsidianHarness\(/g)).toHaveLength(1);
    expect(spec).toContain("test.beforeAll");
    expect(spec).toContain("test.afterAll");
  });
});
