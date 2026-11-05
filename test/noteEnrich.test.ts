import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseLintResponse, lintMaxTokens } from "../src/enrich/noteEnrich";

const reply = (old_str: string, new_str: string): string => JSON.stringify({ complete: true, edits: [{ old_str, new_str }] });

describe("Tidy safe replacements", () => {
  const note = "# Garden\n\nWater teh plants in the morning.\n\nCritical limitation: never water at night.\n";
  it("changes only the exact accepted prose and preserves the remaining note bytes", () => {
    expect(parseLintResponse(reply("Water teh plants", "Water the plants"), note)).toBe(note.replace("teh", "the"));
    expect(parseLintResponse(JSON.stringify({ complete: true, edits: [] }), note)).toBeNull();
  });
  it.each([
    "---\ntitle: Secret\n---\n\nProse.",
    "```ts\nconst secret = 42;\n```\n\nProse.",
    "Read [[Secret]] and `Secret`.",
    "Read ``Secret``.",
    "    Secret",
    "Read [Secret](https://example.com).",
    "> ```ts\n> Secret\n> ```",
  ])("rejects changes to protected Markdown: %s", (original) => {
    expect(() => parseLintResponse(reply("Secret", "Changed"), original)).toThrow();
  });
  it.each([
    "# Garden\n\nWater the plants in the morning.",
    '{"complete":true,"edits":[',
    JSON.stringify({ edits: [] }),
    reply("Water teh plants in the morning.", ""),
    reply(note.trim(), "Water the plants."),
    reply("Water teh plants", "Read [[Different]]"),
  ])("rejects whole-note, incomplete, destructive or non-prose output", (raw) => {
    expect(() => parseLintResponse(raw, note)).toThrow();
  });
  it("rejects ambiguous replacements and preserves numbers", () => {
    expect(() => parseLintResponse(reply("word", "words"), "word word")).toThrow();
    expect(() => parseLintResponse(reply("Use 42 units", "Use 24 units"), "Use 42 units.")).toThrow();
  });
  it("bounds nested blockquote parsing through the actual Tidy parser", () => {
    const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("../src/enrich/noteEnrich.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0]!.text;
    const trigger = `
      const parse = module.exports.parseLintResponse;
      const response = (before, after) => JSON.stringify({ complete: true, edits: [{ old_str: before, new_str: after }] });
      const prefix = '> '.repeat(64);
      const original = prefix + 'quoted prose\\n\\nA teh typo.';
      if (parse(response('teh', 'the'), original) !== original.replace('teh', 'the')) process.exit(2);
      const replacement = prefix + 'the';
      if (parse(response('teh', replacement), 'teh') !== replacement) process.exit(3);
    `;
    const result = spawnSync(process.execPath, ["--input-type=commonjs"], { input: bundle + trigger, encoding: "utf8", timeout: 2000 });
    expect(result.error, "nested quotes must settle without blocking the UI").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("preserves quoted/indented code across line separator %j", (separator) => {
    for (const prefix of ["    ", "\t", ">    ", "> \t", ">\t ", "    > ", "> >    "]) {
      const original = `Unchanged prose.${separator}${prefix}Secret`;
      expect(() => parseLintResponse(reply("Secret", "Changed"), original)).toThrow();
    }
    const original = `Unchanged prose.${separator}> >   A teh typo.`;
    expect(parseLintResponse(reply("teh", "the"), original)).toBe(original.replace("teh", "the"));
  });
  it("bounds the response budget for small edits regardless of note size", () => {
    expect(lintMaxTokens("x".repeat(60000))).toBeLessThanOrEqual(4096);
  });
});
