#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryUrl, rewriteMarkdownLinks } from "./docs-links.mjs";

export async function prepareReleaseDocs(root, out, ref = "main") {
  root = path.resolve(root);
  out = path.resolve(out);
  if (out === root || out === path.join(root, "obsidian-plugin")) throw new Error("Release documentation needs a separate output directory");
  const placement = new Map([[path.join(root, "obsidian-plugin/README.md"), "README.md"], [path.join(root, "LICENSE"), "LICENSE"]]);
  for (const file of await readdir(path.join(root, "guides"))) {
    if (file.endsWith(".md")) placement.set(path.join(root, "guides", file), `guides/${file}`);
  }
  const assets = new Map();
  for (const dir of ["assets", "obsidian-plugin/assets"]) {
    for (const file of await readdir(path.join(root, dir))) {
      if (file.endsWith(".md")) continue;
      const source = path.join(root, dir, file);
      const destination = `assets/${file}`;
      const previous = assets.get(destination);
      if (previous && !(await readFile(previous)).equals(await readFile(source))) throw new Error(`Conflicting documentation asset: ${file}`);
      placement.set(source, destination);
      assets.set(destination, source);
    }
  }
  await rm(path.join(out, "guides"), { recursive: true, force: true });
  await rm(path.join(out, "assets"), { recursive: true, force: true });
  for (const [source, destination] of placement) {
    const target = path.join(out, destination);
    await mkdir(path.dirname(target), { recursive: true });
    if (!source.endsWith(".md")) { await cp(source, target); continue; }
    const body = rewriteMarkdownLinks(await readFile(source, "utf8"), (url, link) => {
      const [part, fragment = ""] = url.split(/(?=#)/);
      if (!part) return url;
      const resolved = path.resolve(path.dirname(source), decodeURIComponent(part));
      const shipped = placement.get(resolved);
      return (shipped ? path.relative(path.dirname(destination), shipped).split(path.sep).join("/") : repositoryUrl(root, resolved, ref, link.image)) + fragment;
    });
    await writeFile(target, body);
  }
  return [...placement.values()].filter((file) => file.endsWith(".md"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, out] = process.argv.slice(2);
  if (!root || !out) throw new Error("usage: prepare-release-docs.mjs <source-repo> <release-repo>");
  const ref = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await prepareReleaseDocs(root, out, ref);
}
