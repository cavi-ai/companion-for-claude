import { expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { compressedSkillRegistry } from "../tools/compress-skill-registry.mjs";
import { SKILLS } from "../src/workflows/skillRegistry.generated";

it("preserves every workflow field and prompt in the compressed browser bundle", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/workflows/skillRegistry.generated.ts", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "cjs", target: "es2021",
    plugins: [compressedSkillRegistry()],
  });
  const exported: { SKILLS?: unknown } = {};
  const sandbox = {
    module: { exports: exported }, exports: exported, atob, Uint8Array, TextDecoder,
  };
  runInNewContext(result.outputFiles[0]!.text, sandbox);
  expect(JSON.parse(JSON.stringify(sandbox.module.exports.SKILLS))).toEqual(SKILLS);
});
