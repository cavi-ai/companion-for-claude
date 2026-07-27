import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORKFLOWS } from "../src/workflows/catalog";

const registryPath = fileURLToPath(new URL("../../claude-plugin/capabilities.json", import.meta.url));
const present = existsSync(registryPath);

interface Capability {
  id: string;
  tier: string;
  name: string;
  description: string;
  surfaces: { skill: boolean; command: string | false; companion: string | false };
}

// The claude-plugin submodule is optional: obsidian-plugin must build and test standalone.
// Guard the read behind `present` too: describe.skipIf only skips the its, not this
// synchronous setup, so an unconditional readFileSync would still throw ENOENT.
describe.skipIf(!present)("companion catalog ↔ capability registry", () => {
  const registry: { capabilities: Capability[] } = present
    ? JSON.parse(readFileSync(registryPath, "utf8"))
    : { capabilities: [] };
  const byId = new Map(registry.capabilities.map((c) => [c.id, c]));

  it("every workflow resolves to a registry entry that declares a companion surface", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(w.id);
      expect(cap, `workflow '${w.id}' is not in capabilities.json`).toBeDefined();
      if (!cap) continue;
      expect(typeof cap.surfaces.companion, `workflow '${w.id}' is not declared as a companion surface`).toBe("string");
    }
  });

  it("every workflow's name and group match the registry", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(w.id);
      expect(cap, `workflow '${w.id}' is not in capabilities.json`).toBeDefined();
      if (!cap) continue;
      expect(w.name, `name drift on '${w.id}'`).toBe(cap.name);
      expect(w.group, `group drift on '${w.id}'`).toBe(cap.surfaces.companion);
    }
  });

  it("every registry entry declaring a companion surface has a workflow", () => {
    const ids = new Set(WORKFLOWS.map((w) => w.id));
    for (const cap of registry.capabilities) {
      if (cap.surfaces.companion === false) continue;
      expect(ids.has(cap.id), `registry declares a companion surface for '${cap.id}' but catalog.ts has no workflow`).toBe(true);
    }
  });
});
