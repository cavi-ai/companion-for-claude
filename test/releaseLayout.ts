import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.resolve(pluginRoot, "..");
const sourceLayout = path.basename(path.resolve(pluginRoot)) === "obsidian-plugin"
  && existsSync(path.join(sourceRoot, ".gitmodules"));

/** The standalone mirror carries exact source inputs exported at generation. */
export function sourceInput(relative: "native-ios/Resources/Model.json" | ".github/workflows/release-obsidian-plugin.yml"): string {
  return sourceLayout
    ? path.join(sourceRoot, relative)
    : path.join(pluginRoot, "test/fixtures/source-layout", relative);
}

/** Source assets are merged into the standalone mirror's assets directory. */
export function documentationAsset(name: string, fromSourceRoot = false): string {
  return path.join(sourceLayout && fromSourceRoot ? sourceRoot : pluginRoot, "assets", name);
}
