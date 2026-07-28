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
  portable: boolean;
  surfaces: { skill: boolean; command: string | false };
}

// The claude-plugin submodule is optional: obsidian-plugin must build and test standalone.
// Guard the read behind `present` too: describe.skipIf only skips the its, not this
// synchronous setup, so an unconditional readFileSync would still throw ENOENT.
describe.skipIf(!present)("Companion adapters ↔ obsidian-agent capability registry", () => {
  const registry: { plugin?: string; transport?: string; capabilities: Capability[] } = present
    ? JSON.parse(readFileSync(registryPath, "utf8"))
    : { capabilities: [] };
  const byId = new Map(registry.capabilities.map((c) => [c.id, c]));

  it("targets the universal CLI registry without restoring Companion metadata", () => {
    expect(registry.plugin).toBe("obsidian-agent");
    expect(registry.transport).toBe("cli");
    for (const cap of registry.capabilities) {
      expect(cap.surfaces).not.toHaveProperty("companion");
    }
  });

  it("every Companion-native workflow adapts a portable universal capability", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(w.id);
      expect(cap, `workflow '${w.id}' is not in capabilities.json`).toBeDefined();
      if (!cap) continue;
      expect(cap.portable, `workflow '${w.id}' adapts a non-portable capability`).toBe(true);
    }
  });

  it("keeps universal capability names aligned while Companion owns presentation groups", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(w.id);
      expect(cap, `workflow '${w.id}' is not in capabilities.json`).toBeDefined();
      if (!cap) continue;
      expect(w.name, `name drift on '${w.id}'`).toBe(cap.name);
      expect(["Manifest", "Knowledge & synthesis"]).toContain(w.group);
    }
  });
});
