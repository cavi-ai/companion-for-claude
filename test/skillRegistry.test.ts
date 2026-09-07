import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSkillEntries, renderRegistry } from "../tools/skill-registry-lib.mjs";
import { SKILLS } from "../src/workflows/skillRegistry.generated";

const pluginDir = fileURLToPath(new URL("../../claude-plugin/", import.meta.url));
const present = existsSync(`${pluginDir}capabilities.json`);

describe.skipIf(!present)("generated skill registry", () => {
  it("equals a fresh generation from the pinned submodule", () => {
    const committed = readFileSync(fileURLToPath(new URL("../src/workflows/skillRegistry.generated.ts", import.meta.url)), "utf8");
    expect(committed).toBe(renderRegistry(buildSkillEntries(pluginDir)));
  });

  it("includes exactly the portable, command-surfaced skills", () => {
    const registry = JSON.parse(readFileSync(`${pluginDir}capabilities.json`, "utf8")) as { capabilities: Array<{ id: string; portable: boolean; surfaces: { skill: boolean; command: string | false } }> };
    const expected = registry.capabilities.filter((c) => c.portable && c.surfaces.skill && c.surfaces.command !== false).map((c) => c.id).sort();
    expect(SKILLS.map((s) => s.id).sort()).toEqual(expected);
  });

  it("inlines required sub-skills once and leaves no directive behind", () => {
    for (const s of SKILLS) expect(s.body).not.toMatch(/REQUIRED SUB-SKILL/);
    const rollup = SKILLS.find((s) => s.id === "daily-rollup");
    expect(rollup?.body).toContain("## Included skill: ");
    expect(rollup?.argHint).toBe("[days, default 7]");
  });
});
