import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "fflate";

// Keep the generated registry readable in source; only the distributed bundle
// carries compressed JSON. The existing worker decoder already includes fflate.
export function compressedSkillRegistry() {
  return {
    name: "compressed-skill-registry",
    setup(build) {
      build.onLoad({ filter: /[/\\]skillRegistry\.generated\.ts$/ }, async ({ path: filename }) => {
        const source = await readFile(filename, "utf8");
        const match = /export const SKILLS: SkillEntry\[\] = ([\s\S]*);\s*$/.exec(source);
        if (!match) throw new Error("Cannot read generated skill registry; regenerate it before bundling.");
        const json = JSON.stringify(JSON.parse(match[1]));
        const data = Buffer.from(gzipSync(new TextEncoder().encode(json), { level: 9, mtime: 0 })).toString("base64");
        return {
          contents: `import { gunzipSync, strFromU8 } from "fflate";
export const SKILLS = JSON.parse(strFromU8(gunzipSync(Uint8Array.from(atob("${data}"), c => c.charCodeAt(0)))));`,
          loader: "js",
          resolveDir: path.dirname(filename),
        };
      });
    },
  };
}
