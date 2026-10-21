import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkMarkdownLinks, headingAnchors, markdownLinks, rewriteMarkdownLinks } from "../tools/docs-links.mjs";
import { prepareReleaseDocs } from "../tools/prepare-release-docs.mjs";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "companion-doc-links-"));
  temporary.push(root);
  const put = async (name: string, body: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  };
  await put("README.md", "# Overview\n\n## Guides\n");
  await put("LICENSE", "MIT\n");
  await put("SECURITY.md", "# Security\n\n## Reporting\n");
  await put("assets/research.png", "research image");
  await put("obsidian-plugin/assets/chat.png", "chat image");
  await put("obsidian-plugin/README.md", "# Companion\n\n[![MIT](https://example.org/badge.svg)](../LICENSE)\n\n[FAQ](../guides/faq.md#answers)\n[Guides](../README.md#guides)\n![Research](../assets/research.png)\n![Chat](assets/chat.png)\n");
  await put("guides/faq.md", '# FAQ\n\n## Answers\n\n[Security](../SECURITY.md#reporting)\n![Chat](../obsidian-plugin/assets/chat.png)\n<img src="../assets/research.png" alt="Research">\n');
  return { root, put };
}

describe("documentation links", () => {
  it("reads nested badges, references, angle destinations, and HTML while ignoring code", () => {
    const body = '[![MIT](badge.svg)](LICENSE)\n![Screen][shot]\n[FAQ](<guides/my faq.md> "Help")\n<img src="chat.png">\n\n[shot]: screen.png\n\n`[sample](missing.md)`\n\n```md\n[example](absent.md)\n```\n';
    expect(markdownLinks(body).map((link) => link.url)).toEqual(["LICENSE", "badge.svg", "guides/my faq.md", "chat.png", "screen.png"]);
    expect(markdownLinks(body).find((link) => link.url === "screen.png")?.image).toBe(true);
    expect(rewriteMarkdownLinks(body, (url) => `docs/${url}`)).toBe(body
      .replace("](LICENSE)", "](docs/LICENSE)").replace("(badge.svg)", "(docs/badge.svg)")
      .replace("<guides/my faq.md>", "<docs/guides/my faq.md>").replace('src="chat.png"', 'src="docs/chat.png"')
      .replace("[shot]: screen.png", "[shot]: docs/screen.png"));
  });

  it("uses GitHub heading slugs, duplicate suffixes, and explicit anchors", () => {
    const body = '# Café & **notes**\n\n## Repeated\n\n## Repeated\n\n<a id="custom"></a>\n\n```md\n# Not a heading\n```\n';
    expect([...headingAnchors(body)]).toEqual(["café--notes", "repeated", "repeated-1", "custom"]);
    expect(rewriteMarkdownLinks("[Section](#repeated)", () => "wrong.md")).toBe("[Section](#repeated)");
  });

  it("detects missing images, reference targets, fragments, and out-of-root links", async () => {
    const { root, put } = await fixture();
    await put("broken.md", '[![badge](assets/research.png)](missing.md)\n[Wrong](README.md#absent)\n[Reference][r]\n<img src="absent.png">\n[Escape](../outside.md)\n\n[r]: not-there.md\n');
    const errors = await checkMarkdownLinks(root, ["broken.md"]);
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).toContain("missing heading #absent");
    expect(errors.join("\n")).toContain("not-there.md (missing target)");
    expect(errors.join("\n")).toContain("absent.png (missing target)");
    expect(errors.join("\n")).toContain("target is outside documentation root");
  });

  it("checks absolute repository links, including a missing branch segment", async () => {
    const { root, put } = await fixture();
    await put("absolute.md", '[Good](https://github.com/cavi-ai/claude-obsidian/blob/main/guides/faq.md#answers)\n[Broken](https://github.com/cavi-ai/claude-obsidian/blob/guides/faq.md)\n');
    const errors = await checkMarkdownLinks(root, ["absolute.md"], { "cavi-ai/claude-obsidian": root });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("blob/guides/faq.md (missing target)");
  });

  it("rewrites standalone docs, includes both asset directories, and validates source fallbacks", async () => {
    const { root } = await fixture();
    const mirror = path.join(root, "mirror");
    const files = await prepareReleaseDocs(root, mirror, "main");
    const readme = await readFile(path.join(mirror, "README.md"), "utf8");
    expect(readme).toContain("](LICENSE)");
    expect(readme).toContain("(guides/faq.md#answers)");
    expect(readme).toContain("(assets/research.png)");
    expect(readme).toContain("(assets/chat.png)");
    expect(readme).toContain("https://github.com/cavi-ai/claude-obsidian/blob/main/README.md#guides");
    const faq = await readFile(path.join(mirror, "guides/faq.md"), "utf8");
    expect(faq).toContain("https://github.com/cavi-ai/claude-obsidian/blob/main/SECURITY.md#reporting");
    expect(faq).toContain("(../assets/chat.png)");
    expect(faq).toContain('src="../assets/research.png"');
    expect(await checkMarkdownLinks(mirror, files, { "cavi-ai/claude-obsidian": root })).toEqual([]);
    await writeFile(path.join(mirror, "guides/stale.md"), "stale");
    await prepareReleaseDocs(root, mirror, "main");
    await expect(readFile(path.join(mirror, "guides/stale.md"))).rejects.toThrow();
  });

  it("builds and verifies website artifacts from source and standalone layouts", async () => {
    const { root } = await fixture();
    const mirror = path.join(root, "mirror");
    await prepareReleaseDocs(root, mirror, "main");
    for (const standalone of [false, true]) {
      const source = standalone ? mirror : root;
      const out = path.join(root, standalone ? "standalone-artifact" : "source-artifact");
      const result = execFileSync(process.execPath, ["tools/build-docs-artifact.mjs",
        "--version", "1.2.3", "--tag", "1.2.3", "--commit", "a".repeat(40),
        "--guides", path.join(source, "guides"), "--readme", path.join(source, standalone ? "README.md" : "obsidian-plugin/README.md"),
        "--out", out, "--source-date-epoch", "1",
      ], { encoding: "utf8" }).trim();
      const artifact = path.join(out, result);
      expect(execFileSync(process.execPath, ["tools/verify-docs-artifact.mjs", artifact], { encoding: "utf8" })).toContain("docs artifact OK");
      const overview = await readFile(path.join(artifact, "introduction/overview.md"), "utf8");
      expect(overview).toContain("../guides/faq.md#answers");
      expect(overview).toContain(`https://raw.githubusercontent.com/cavi-ai/${standalone ? "companion-for-claude" : "claude-obsidian"}/${"a".repeat(40)}/assets/research.png`);
      expect(await checkMarkdownLinks(artifact, ["introduction/overview.md", "guides/faq.md"], {
        "cavi-ai/claude-obsidian": root, "cavi-ai/companion-for-claude": mirror,
      })).toEqual([]);
    }
  });
});
