import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import GithubSlugger from "github-slugger";

const external = (url) => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url);

function visit(node, fn) {
  fn(node);
  for (const child of node.children ?? []) visit(child, fn);
}

// Locate destinations in the original Markdown so rewriting preserves prose,
// formatting, reference labels, image alt text, and nested badge links.
export function markdownLinks(body) {
  const links = [];
  const tree = fromMarkdown(body);
  const imageReferences = new Set();
  visit(tree, (node) => { if (node.type === "imageReference") imageReferences.add(node.identifier); });
  visit(tree, (node) => {
    const offset = node.position?.start.offset;
    if (offset === undefined) return;
    if (node.type === "html") {
      for (const match of node.value.matchAll(/\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const url = match[2] ?? match[3] ?? match[4];
        const start = offset + match.index + match[0].indexOf("=") + 1;
        const valueStart = start + match[0].slice(match[0].indexOf("=") + 1).search(/[^\s"']/);
        links.push({ url, start: valueStart, end: valueStart + url.length, image: match[1].toLowerCase() === "src" });
      }
      return;
    }
    if (!["link", "image", "definition"].includes(node.type)) return;
    const raw = body.slice(offset, node.position.end.offset);
    let start;
    if (node.type === "definition") start = raw.indexOf("]:") + 2;
    else if (raw.startsWith("<")) start = 1;
    else start = raw.lastIndexOf("](") + 2;
    while (/\s/.test(raw[start] ?? "") && start < raw.length) start++;
    const angle = raw[start] === "<" || raw.startsWith("<");
    if (raw[start] === "<") start++;
    let end = start;
    let depth = 0;
    for (; end < raw.length; end++) {
      const char = raw[end];
      if (char === "\\") { end++; continue; }
      if (angle && char === ">") break;
      if (!angle && (char === ")" && depth === 0 || /\s/.test(char))) break;
      if (char === "(") depth++;
      if (char === ")") depth--;
    }
    links.push({ url: node.url, start: offset + start, end: offset + end, image: node.type === "image" || imageReferences.has(node.identifier) });
  });
  return links;
}

export function rewriteMarkdownLinks(body, resolve) {
  for (const link of markdownLinks(body).sort((a, b) => b.start - a.start)) {
    if (external(link.url) || link.url.startsWith("#")) continue;
    const next = resolve(link.url, link);
    if (next !== undefined && next !== link.url) body = body.slice(0, link.start) + next + body.slice(link.end);
  }
  return body;
}

export function headingAnchors(body) {
  const slugger = new GithubSlugger();
  const anchors = new Set();
  const text = (node) => node.type === "html" ? "" : node.value ?? node.alt ?? (node.children ?? []).map(text).join("");
  visit(fromMarkdown(body), (node) => {
    if (node.type === "heading") anchors.add(slugger.slug(text(node)));
    if (node.type === "html") {
      for (const match of node.value.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
    }
  });
  return anchors;
}

export function repositoryUrl(root, file, ref, image = false, repository = "cavi-ai/claude-obsidian") {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Documentation target outside repository: ${file}`);
  const encoded = relative.split(path.sep).map(encodeURIComponent).join("/");
  return image
    ? `https://raw.githubusercontent.com/${repository}/${ref}/${encoded}`
    : `https://github.com/${repository}/blob/${ref}/${encoded}`;
}

// repositoryRoots lets generated docs validate their absolute source links too,
// without making CI depend on the network or a not-yet-published commit.
export async function checkMarkdownLinks(root, files, repositoryRoots = {}) {
  const errors = [];
  const headings = new Map();
  for (const file of files) {
    const full = path.resolve(root, file);
    const body = await readFile(full, "utf8");
    for (const { url, image } of markdownLinks(body)) {
      let target;
      let fragment;
      try {
        if (external(url)) {
          const parsed = new URL(url);
          const parts = parsed.pathname.split("/").filter(Boolean);
          const raw = parsed.hostname === "raw.githubusercontent.com";
          if (!raw && (parsed.hostname !== "github.com" || !["blob", "tree"].includes(parts[2]))) continue;
          const sourceRoot = repositoryRoots[parts.slice(0, 2).join("/")];
          if (!sourceRoot) continue;
          target = path.resolve(sourceRoot, decodeURIComponent(parts.slice(raw ? 3 : 4).join("/")));
          fragment = parsed.hash.slice(1);
        } else {
          const parsed = new URL(url, "https://docs.invalid/");
          const pathPart = url.split(/[?#]/, 1)[0];
          target = pathPart ? path.resolve(path.dirname(full), decodeURIComponent(pathPart)) : full;
          fragment = parsed.hash.slice(1);
          if (path.relative(root, target).startsWith("..")) throw new Error("target is outside documentation root");
        }
        const info = await stat(target);
        if (image && !info.isFile()) throw new Error("image target is not a file");
        if (fragment && /\.md$/i.test(target)) {
          if (!headings.has(target)) headings.set(target, headingAnchors(await readFile(target, "utf8")));
          if (!headings.get(target).has(decodeURIComponent(fragment))) throw new Error(`missing heading #${fragment}`);
        }
      } catch (error) {
        errors.push(`${file}: ${url} (${error.code === "ENOENT" ? "missing target" : error.message})`);
      }
    }
  }
  return errors;
}
