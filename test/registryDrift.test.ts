import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORKFLOWS } from "../src/workflows/catalog";

const registryPath = fileURLToPath(new URL("../../claude-plugin/capabilities.json", import.meta.url));
const present = existsSync(registryPath);

interface Lens {
  id: string;
  name: string;
}

interface Capability {
  id: string;
  tier: string;
  name: string;
  description: string;
  portable: boolean;
  surfaces: { skill: boolean; command: string | false };
  lenses?: Lens[];
}

// The claude-plugin submodule is optional: obsidian-plugin must build and test standalone.
// Guard the read behind `present` too: describe.skipIf only skips the its, not this
// synchronous setup, so an unconditional readFileSync would still throw ENOENT.
describe.skipIf(!present)("Companion adapters ↔ obsidian-agent capability registry", () => {
  const registry: { plugin?: string; transport?: string; capabilities: Capability[] } = present
    ? JSON.parse(readFileSync(registryPath, "utf8"))
    : { capabilities: [] };
  const byId = new Map(registry.capabilities.map((c) => [c.id, c]));
  // A lens capability is one skill with named variants; several workflows adapt one capability.
  const capabilityOf = (w: (typeof WORKFLOWS)[number]) => w.capability ?? w.id;
  const lensOf = (cap: Capability | undefined, w: (typeof WORKFLOWS)[number]) =>
    cap?.lenses?.find((l) => l.id === w.lens);

  it("targets the universal CLI registry without restoring Companion metadata", () => {
    expect(registry.plugin).toBe("obsidian-agent");
    expect(registry.transport).toBe("cli");
    for (const cap of registry.capabilities) {
      expect(cap.surfaces).not.toHaveProperty("companion");
    }
  });

  it("every Companion-native workflow adapts a portable universal capability", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(capabilityOf(w));
      expect(cap, `workflow '${w.id}' adapts '${capabilityOf(w)}', which is not in capabilities.json`).toBeDefined();
      if (!cap) continue;
      expect(cap.portable, `workflow '${w.id}' adapts a non-portable capability`).toBe(true);
    }
  });

  it("keeps universal capability names aligned while Companion owns presentation groups", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(capabilityOf(w));
      expect(cap, `workflow '${w.id}' is not in capabilities.json`).toBeDefined();
      if (!cap) continue;
      const expected = w.lens === undefined ? cap.name : lensOf(cap, w)?.name;
      expect(w.name, `name drift on '${w.id}'`).toBe(expected);
      expect(["Manifest", "Knowledge & synthesis"]).toContain(w.group);
    }
  });

  it("only declares a lens the capability actually offers, and derives the id from it", () => {
    for (const w of WORKFLOWS) {
      const cap = byId.get(capabilityOf(w));
      if (!cap) continue;
      if (w.lens === undefined) {
        expect(w.capability ?? w.id, `'${w.id}' names a capability but no lens`).toBe(w.id);
        continue;
      }
      const declared = (cap.lenses ?? []).map((l) => l.id);
      expect(declared, `'${w.id}' uses lens '${w.lens}', which '${cap.id}' does not declare`).toContain(w.lens);
      expect(w.id, `id must derive from capability and lens`).toBe(`${cap.id}-${w.lens}`);
    }
  });

  it("adapts every lens of an adapted lens capability exactly once", () => {
    const adapted = new Set(WORKFLOWS.map(capabilityOf));
    for (const cap of registry.capabilities) {
      if (!cap.lenses || !adapted.has(cap.id)) continue;
      for (const lens of cap.lenses) {
        const matches = WORKFLOWS.filter((w) => capabilityOf(w) === cap.id && w.lens === lens.id);
        expect(matches.length, `lens '${cap.id}:${lens.id}' has ${matches.length} workflows`).toBe(1);
      }
    }
  });
});
