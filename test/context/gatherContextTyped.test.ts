import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { gatherContext } from "../../src/context/vaultContext";
import { OntologyRegistry } from "../../src/ontology/registry";
import { DEFAULT_SETTINGS } from "../../src/types";
import { hits, linkingApp, seededRegistry, setActive } from "./typedVault";

const NO_TOGGLES = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
const SEARCH_ONLY = { ...NO_TOGGLES, searchVault: true };
const MARKER = "\n…[truncated]";
const OLD_CITATION =
  'When you draw on the "Search match" notes above, cite each inline as an ' +
  "Obsidian wikilink — [[Note Name]], using the note's file name without the " +
  "folder path or .md extension — so the reader can click through to the source.";
const NEW_CITATION = OLD_CITATION.replace('"Search match" notes', '"Search match" or "Related" notes');

const ANN = { type: "person", works_on: ["[[Alpha|the alpha]]"], knows: ["[[Bob#Intro]]", "[[Diagram.png]]", "[[Nowhere]]"] };

function vault(ann: Record<string, unknown> = ANN, alpha = "ALPHA BODY"): App {
  const a = linkingApp();
  a.vault.seed("People/Ann.md", "ANN BODY", { frontmatter: ann });
  a.vault.seed("Projects/Alpha.md", alpha, { frontmatter: { type: "project" } });
  a.vault.seed("People/Bob.md", "BOB BODY", { frontmatter: { type: "person" } });
  a.vault.seed("Assets/Diagram.png", "PNG BODY");
  a.vault.seed("Home.md", "HOME BODY");
  return a;
}

const blocks = (text: string): string[] => text.split("\n\n").slice(1, -1);
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("gatherContext — typed context", () => {
  it("labels the search match and adds its resolved markdown relation targets in declaration order", async () => {
    const ctx = await gatherContext(vault(), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, await seededRegistry());
    expect(ctx.text).toBe(
      [
        "<vault_context>",
        "### Search match: People/Ann.md (type: person)\nS",
        "### Related (works_on of People/Ann.md): Projects/Alpha.md (type: project)\nALPHA BODY",
        "### Related (knows of People/Ann.md): People/Bob.md (type: person)\nBOB BODY",
        NEW_CITATION,
        "</vault_context>",
      ].join("\n\n"),
    );
    expect(ctx.sources).toEqual(["1 semantic match", "2 related notes"]);
    expect(ctx.text).not.toContain("PNG BODY");
  });

  it("is identical to the untyped output with no registry, an empty registry, or no typed matches", async () => {
    const expected = ["<vault_context>", "### Search match: People/Ann.md\nS", OLD_CITATION, "</vault_context>"].join("\n\n");
    const empty = new OntologyRegistry({ listSchemaNotes: () => Promise.resolve([]), parseYaml: () => ({}) });
    await empty.load();
    const untypedAnn = { works_on: ANN.works_on, knows: ANN.knows };
    const runs = [
      await gatherContext(vault(), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], []),
      await gatherContext(vault(), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, null),
      await gatherContext(vault(), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, empty),
      await gatherContext(vault(untypedAnn), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, await seededRegistry()),
    ];
    for (const ctx of runs) {
      expect(ctx.text).toBe(expected);
      expect(ctx.sources).toEqual(["1 semantic match"]);
    }
  });

  it("labels a padded type exactly as written and follows none of its relations", async () => {
    const ctx = await gatherContext(vault({ ...ANN, type: " person" }), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, await seededRegistry());
    expect(ctx.text).toBe(["<vault_context>", "### Search match: People/Ann.md (type:  person)\nS", OLD_CITATION, "</vault_context>"].join("\n\n"));
    expect(ctx.sources).toEqual(["1 semantic match"]);
  });

  it("labels linked notes only with a typed registry and never expands from them", async () => {
    const toggles = { ...NO_TOGGLES, linkedNotes: true };
    const make = (): App => {
      const a = vault();
      a.metadataCache.resolvedLinks = { "Home.md": { "People/Ann.md": 1 } };
      setActive(a, "Home.md");
      return a;
    };
    const typed = await gatherContext(make(), DEFAULT_SETTINGS, toggles, "qqq", undefined, [], [], undefined, await seededRegistry());
    expect(typed.text).toContain("### Linked note: People/Ann.md (type: person)\nANN BODY");
    expect(typed.text).not.toContain("Related");
    const plain = await gatherContext(make(), DEFAULT_SETTINGS, toggles, "qqq", undefined, [], []);
    expect(plain.text).toContain("### Linked note: People/Ann.md\nANN BODY");
  });

  it("never repeats the active note, an attached note, or a linked note as a related note", async () => {
    const reg = await seededRegistry();
    const activeAttached = vault();
    setActive(activeAttached, "Projects/Alpha.md");
    const a = await gatherContext(activeAttached, DEFAULT_SETTINGS, { ...SEARCH_ONLY, activeNote: true }, "qqq", hits("People/Ann.md"), [{ path: "People/Bob.md", kind: "note" }], [], undefined, reg);
    expect(count(a.text, "ALPHA BODY")).toBe(1);
    expect(count(a.text, "BOB BODY")).toBe(1);
    expect(a.text).not.toContain("### Related");
    expect(a.text).toContain(OLD_CITATION);
    expect(a.sources).toEqual(["active note", "1 attached", "1 semantic match"]);

    const activeOff = vault();
    setActive(activeOff, "Projects/Alpha.md");
    const b = await gatherContext(activeOff, DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, reg);
    expect(b.text).not.toContain("ALPHA BODY");
    expect(b.text).toContain("### Related (knows of People/Ann.md): People/Bob.md (type: person)\nBOB BODY");

    const linked = vault();
    linked.metadataCache.resolvedLinks = { "Home.md": { "People/Bob.md": 1 } };
    setActive(linked, "Home.md");
    const c = await gatherContext(linked, DEFAULT_SETTINGS, { ...SEARCH_ONLY, linkedNotes: true }, "qqq", hits("People/Ann.md"), [], [], undefined, reg);
    expect(count(c.text, "BOB BODY")).toBe(1);
    expect(c.text).toContain("### Linked note: People/Bob.md (type: person)");
    expect(c.text).toContain("### Related (works_on of People/Ann.md): Projects/Alpha.md (type: project)");
    expect(c.sources).toEqual(["1 linked note", "1 semantic match", "1 related note"]);
  });

  it("adds at most three related notes across matches", async () => {
    const a = vault({ type: "person", knows: ["[[P1]]", "[[P2]]", "[[P3]]", "[[P4]]"] });
    for (const n of [1, 2, 3, 4]) a.vault.seed(`People/P${n}.md`, `P${n} BODY`, { frontmatter: { type: "person" } });
    const ctx = await gatherContext(a, DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, await seededRegistry());
    expect(count(ctx.text, "### Related")).toBe(3);
    expect(ctx.text).not.toContain("P4 BODY");
    expect(ctx.sources).toEqual(["1 semantic match", "3 related notes"]);
  });

  it("adds at most three related notes across two matches", async () => {
    const a = vault({ type: "person", knows: ["[[P1]]", "[[P2]]"] });
    a.vault.seed("People/Cal.md", "CAL BODY", { frontmatter: { type: "person", knows: ["[[P3]]", "[[P4]]"] } });
    for (const n of [1, 2, 3, 4]) a.vault.seed(`People/P${n}.md`, `P${n} BODY`, { frontmatter: { type: "person" } });
    const ctx = await gatherContext(a, DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md", "People/Cal.md"), [], [], undefined, await seededRegistry());
    expect(count(ctx.text, "### Related (")).toBe(3);
    expect(ctx.text).toContain("### Related (knows of People/Ann.md): People/P1.md (type: person)\nP1 BODY");
    expect(ctx.text).toContain("### Related (knows of People/Ann.md): People/P2.md (type: person)\nP2 BODY");
    expect(ctx.text).toContain("### Related (knows of People/Cal.md): People/P3.md (type: person)\nP3 BODY");
    expect(ctx.text).not.toContain("P4 BODY");
    expect(ctx.sources).toEqual(["2 semantic matches", "3 related notes"]);
  });

  it("clips a related note to 1500 chars and stops at the context budget", async () => {
    const long = "Z".repeat(5000);
    const header = "### Related (works_on of People/Ann.md): Projects/Alpha.md (type: project)\n";
    const reg = await seededRegistry();
    const roomy = await gatherContext(vault(ANN, long), DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, reg);
    expect(blocks(roomy.text)).toContain((header + long).slice(0, 1500) + MARKER);

    const match = "### Search match: People/Ann.md (type: person)\nS";
    const budget = match.length + 100;
    const tight = await gatherContext(vault(ANN, long), { ...DEFAULT_SETTINGS, contextCharBudget: budget }, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, reg);
    expect(blocks(tight.text)).toEqual([match, (header + long).slice(0, 100) + MARKER]);
    expect(tight.sources).toEqual(["1 semantic match", "1 related note"]);

    const full = await gatherContext(vault(), { ...DEFAULT_SETTINGS, contextCharBudget: match.length }, SEARCH_ONLY, "qqq", hits("People/Ann.md"), [], [], undefined, reg);
    expect(blocks(full.text)).toEqual([match]);
    expect(full.sources).toEqual(["1 semantic match"]);
  });

  it("follows relations from the first three included search matches only", async () => {
    const a = vault();
    for (const n of [1, 2, 3]) a.vault.seed(`M/M${n}.md`, `M${n}`, { frontmatter: { type: "concept" } });
    const ctx = await gatherContext(a, DEFAULT_SETTINGS, SEARCH_ONLY, "qqq", hits("M/M1.md", "M/M2.md", "M/M3.md", "People/Ann.md"), [], [], undefined, await seededRegistry());
    expect(ctx.text).toContain("### Search match: People/Ann.md (type: person)");
    expect(ctx.text).not.toContain("### Related");
  });
});
