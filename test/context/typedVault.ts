import { App } from "obsidian";
import { parse as parseYaml } from "yaml";
import { OntologyRegistry } from "../../src/ontology/registry";
import { schemaNoteContent, SEED_TYPES } from "../../src/ontology/seed";

export async function seededRegistry(): Promise<OntologyRegistry> {
  const reg = new OntologyRegistry({
    listSchemaNotes: () =>
      Promise.resolve(
        SEED_TYPES.map((d) => {
          const m = schemaNoteContent(d).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
          return { path: `Ontology/${d.name}.md`, frontmatter: parseYaml(m[1] ?? "") as Record<string, unknown>, body: m[2] ?? "" };
        }),
      ),
    parseYaml,
  });
  await reg.load();
  return reg;
}

/** Fake app whose metadataCache resolves a linkpath by path, path + ".md", or file name, like Obsidian's shortest-path links. */
export function linkingApp(): App {
  const a = new App();
  a.workspace = { getActiveViewOfType: () => null, getActiveFile: () => null } as never;
  Object.assign(a.metadataCache, {
    getFirstLinkpathDest: (linkpath: string) => {
      const files = a.vault.getFiles();
      return (
        files.find((f) => f.path === linkpath || f.path === `${linkpath}.md`) ??
        files.find((f) => f.path.split("/").pop() === linkpath || (f.extension === "md" && f.basename === linkpath)) ??
        null
      );
    },
  });
  return a;
}

export function setActive(a: App, path: string): void {
  const f = a.vault.getAbstractFileByPath(path);
  a.workspace = { getActiveViewOfType: () => null, getActiveFile: () => f } as never;
}

/** Semantic retriever returning fixed hits, so snippets are exact. */
export function hits(...paths: string[]) {
  return async () => paths.map((path) => ({ path, text: "S" }));
}
