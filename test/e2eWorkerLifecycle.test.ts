import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("E2E worker lifecycle", () => {
  it("routes every spec through the shared worker teardown fixture", async () => {
    const directory = path.resolve("e2e");
    const specs = (await readdir(directory)).filter((name) => name.endsWith(".spec.ts"));

    for (const spec of specs) {
      const source = await readFile(path.join(directory, spec), "utf8");
      expect(source, spec).toContain('from "./fixtures"');
    }
  });
});
