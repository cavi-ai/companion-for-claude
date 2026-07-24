import { describe, it, expect } from "vitest";
import { settingDefinitions } from "../src/settingsDefinitions";

interface GroupDef {
  type?: string;
  heading?: string;
  items?: Array<{ name?: string }>;
  name?: string;
}

describe("settingDefinitions", () => {
  const defs = settingDefinitions() as GroupDef[];

  it("returns non-empty groups with non-empty items", () => {
    expect(defs.length).toBeGreaterThan(5);
    for (const d of defs) {
      expect(d.type).toBe("group");
      expect(d.heading?.trim().length).toBeGreaterThan(0);
      expect(d.items?.length).toBeGreaterThan(0);
      for (const item of d.items ?? []) {
        expect(item.name?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate setting names", () => {
    const names = defs.flatMap((d) => (d.items ?? []).map((i) => i.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries no controls (search metadata only — cannot mutate values)", () => {
    const json = JSON.stringify(defs);
    expect(json).not.toContain('"control"');
    expect(json).not.toContain('"action"');
  });
});
