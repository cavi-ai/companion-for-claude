import { App, TFile, TFolder, clearNotices, getNoticeMessages } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { NoteFlows } from "../../src/enrich/noteFlows";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";

const ui = vi.hoisted(() => ({
  options: null as unknown,
  decision: null as unknown,
  accepted: null as boolean[] | null,
  batch: null as unknown,
  apply: false,
  optionCounts: [] as number[],
  proposals: [] as unknown[],
  diffs: [] as Array<{ path: string; description: string }>,
  frontmatter: [] as Array<{ basename: string; proposal: Record<string, unknown>; label: string }>,
}));
const tagger = vi.hoisted(() => ({ summarizeAndTag: vi.fn() }));
const lint = vi.hoisted(() => ({ parseLintResponse: vi.fn() }));

vi.mock("../../src/indexing/autoTagger", () => tagger);
vi.mock("../../src/enrich/noteEnrich", () => ({
  LINT_SYSTEM: "lint-system",
  buildLintUser: (body: string) => `lint:${body}`,
  lintMaxTokens: () => 111,
  parseLintResponse: lint.parseLintResponse,
}));
vi.mock("../../src/view/EnrichModal", () => ({
  EnrichOptionsModal: class {
    constructor(_app: unknown, private count: number, private resolve: (value: unknown) => void) {}
    open(): void { ui.optionCounts.push(this.count); this.resolve(ui.options); }
  },
  EnrichReviewModal: class {
    constructor(_app: unknown, private proposal: unknown, private resolve: (value: unknown) => void) {}
    open(): void { ui.proposals.push(this.proposal); this.resolve(ui.decision); }
  },
}));
vi.mock("../../src/view/DiffModal", () => ({
  DiffModal: class {
    constructor(_app: unknown, private opts: { path: string; description: string }, private resolve: (value: unknown) => void) {}
    open(): void { ui.diffs.push(this.opts); this.resolve(ui.accepted); }
  },
}));
vi.mock("../../src/view/BatchDiffModal", () => ({
  BatchDiffModal: class {
    constructor(_app: unknown, _plans: unknown, private resolve: (value: unknown) => void) {}
    open(): void { this.resolve(ui.batch); }
  },
}));
vi.mock("../../src/view/FrontmatterModal", () => ({
  FrontmatterModal: class {
    constructor(_app: unknown, private basename: string, private proposal: Record<string, unknown>, private label: string, private cb: (apply: boolean) => Promise<void>) {}
    open(): void {
      ui.frontmatter.push({ basename: this.basename, proposal: this.proposal, label: this.label });
      void this.cb(ui.apply);
    }
  },
}));

const OPTIONS = { rename: false, frontmatter: false, links: false, lint: false };

interface Rig {
  app: App;
  flows: NoteFlows;
  settings: PluginSettings;
  activity: ActivityStore;
  complete: ReturnType<typeof vi.fn>;
  ontologyTypes: string[] | null;
}

function rig(over: { ontology?: string[] } = {}): Rig {
  const app = new App();
  setActive(app, null);
  const settings = structuredClone(DEFAULT_SETTINGS);
  const activity = new ActivityStore();
  const complete = vi.fn(async () => ({ text: "TYPE: -\nTAGS: alpha, beta\nSUMMARY: A note.", provider: { label: "Utility" } }));
  const flows = new NoteFlows({
    app,
    settings: () => settings,
    activity: () => activity,
    router: () => ({ complete }) as never,
    ontology: () => (over.ontology ? ({ resolved: () => new Map(over.ontology!.map((name) => [name, {}])) } as never) : null),
  });
  return { app, flows, settings, activity, complete, ontologyTypes: over.ontology ?? null };
}

const setActive = (app: App, file: TFile | null): void => {
  (app.workspace as unknown as { getActiveFile: () => TFile | null }).getActiveFile = () => file;
};

beforeEach(() => {
  clearNotices();
  ui.options = null; ui.decision = null; ui.accepted = null; ui.batch = null; ui.apply = false;
  ui.optionCounts.length = 0; ui.proposals.length = 0; ui.diffs.length = 0; ui.frontmatter.length = 0;
  tagger.summarizeAndTag.mockReset();
  lint.parseLintResponse.mockReset();
});

describe("NoteFlows links", () => {
  it("lists every markdown note with its frontmatter aliases", () => {
    const { app, flows } = rig();
    app.vault.seed("A.md", "", { frontmatter: { aliases: ["Alpha", "Aleph"] } });
    app.vault.seed("B.md", "", { frontmatter: { aliases: "Bee" } });
    app.vault.seed("C.md", "", { frontmatter: { aliases: "  " } });
    app.vault.seed("D.md", "");
    app.vault.seed("E.txt", "");
    const byPath = Object.fromEntries(flows.linkCandidates().map((c) => [c.path, c]));
    expect(Object.keys(byPath).sort()).toEqual(["A.md", "B.md", "C.md", "D.md"]);
    expect(byPath["A.md"]).toMatchObject({ basename: "A", aliases: ["Alpha", "Aleph"] });
    expect(byPath["B.md"]).toMatchObject({ aliases: ["Bee"] });
    expect(byPath["C.md"]).toMatchObject({ aliases: [] });
    expect(byPath["D.md"]).toMatchObject({ aliases: [] });
  });

  it("returns the paths a note already links to", () => {
    const { app, flows } = rig();
    const note = app.vault.seed("A.md", "");
    (app.metadataCache as unknown as { resolvedLinks: Record<string, Record<string, number>> }).resolvedLinks = { "A.md": { "B.md": 1, "C.md": 2 } };
    expect([...flows.linkedTargets(note)].sort()).toEqual(["B.md", "C.md"]);
    expect(flows.linkedTargets(app.vault.seed("Z.md", "")).size).toBe(0);
  });
});

describe("NoteFlows reviewLinkSuggestions", () => {
  it("asks for a note when none is open or it is not markdown", async () => {
    const { app, flows } = rig();
    await flows.reviewLinkSuggestions();
    setActive(app, new TFile("a.pdf", "", 0));
    await flows.reviewLinkSuggestions();
    expect(getNoticeMessages()).toEqual(["Open a note first.", "Open a note first."]);
  });

  it("reports when nothing in the note can be linked", async () => {
    const { app, flows } = rig();
    app.vault.seed("Notes/Atlas.md", "");
    const doc = app.vault.seed("Notes/Doc.md", "Nothing relevant here.");
    await flows.reviewLinkSuggestions(doc);
    expect(getNoticeMessages()).toEqual(["No unlinked mentions found."]);
    expect(ui.diffs).toEqual([]);
  });

  it("links the accepted mentions after review and reports the count", async () => {
    const { app, flows } = rig();
    app.vault.seed("Notes/Atlas.md", "");
    const doc = app.vault.seed("Notes/Doc.md", "We met Atlas today.");
    ui.accepted = [true];
    await flows.reviewLinkSuggestions(doc);
    expect(ui.diffs).toMatchObject([{ path: "Notes/Doc.md", description: "Link 1 unlinked mention" }]);
    expect(doc._content).toBe("We met [[Atlas]] today.");
    expect(getNoticeMessages()).toEqual(["Linked 1 mention in Doc."]);
  });

  it("writes nothing when the review is dismissed", async () => {
    const { app, flows } = rig();
    app.vault.seed("Notes/Atlas.md", "");
    const doc = app.vault.seed("Notes/Doc.md", "We met Atlas today.");
    ui.accepted = null;
    await flows.reviewLinkSuggestions(doc);
    expect(doc._content).toBe("We met Atlas today.");
    expect(getNoticeMessages()).toEqual([]);
  });

  it("falls back to the active note and surfaces a write failure as a notice", async () => {
    const { app, flows } = rig();
    app.vault.seed("Notes/Atlas.md", "");
    const doc = app.vault.seed("Notes/Doc.md", "We met Atlas today.");
    setActive(app, doc);
    ui.accepted = [true];
    vi.spyOn(app.vault, "process").mockRejectedValue(new Error("vault locked"));
    await flows.reviewLinkSuggestions();
    expect(getNoticeMessages()).toEqual(["vault locked"]);
  });

  it("returns null from the Inbox batch review when the selection is dismissed", async () => {
    const { app, flows } = rig();
    app.vault.seed("Notes/Atlas.md", "");
    const clip = app.vault.seed("Clippings/clip.md", "Atlas is mentioned.");
    ui.batch = null;
    await expect(flows.reviewInboxLinkSuggestions([clip])).resolves.toBeNull();
  });
});

describe("NoteFlows enrichNoteFlow", () => {
  it("stops quietly when the step picker is dismissed", async () => {
    const { app, flows } = rig();
    const note = app.vault.seed("Notes/Doc.md", "text");
    await flows.enrichNoteFlow(note);
    expect(ui.optionCounts).toEqual([1]);
    expect(tagger.summarizeAndTag).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toEqual([]);
  });

  it("reports a note that needs no change and finishes its activity", async () => {
    const { app, flows, activity } = rig();
    const note = app.vault.seed("Notes/Doc.md", "text");
    await flows.enrichNoteFlow(note, OPTIONS);
    expect(getNoticeMessages()).toEqual(["Doc is already in good shape."]);
    expect(ui.optionCounts).toEqual([]);
    expect(activity.snapshot().records.map((r) => r.state)).not.toContain("running");
  });

  it("proposes a rename and merged tags, then applies only what the review accepts", async () => {
    const { app, flows } = rig();
    const note = app.vault.seed("Doc.md", "---\ntags:\n  - existing\n---\nbody", { frontmatter: { tags: ["existing"] } });
    app.vault.seed("New Title.md", "taken");
    tagger.summarizeAndTag.mockResolvedValue({ title: "New Title", tags: ["existing", "fresh"], newTags: ["fresh"], summary: "Summary." });
    ui.decision = { accepted: [], frontmatter: true, rename: true };
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true, frontmatter: true });
    expect(ui.proposals[0]).toMatchObject({
      path: "Doc.md",
      rename: { from: "Doc.md", to: "New Title 2.md" },
      frontmatter: { tags: ["existing", "fresh"], summary: "Summary.", addedTags: ["fresh"], newTags: ["fresh"] },
    });
    expect(note.path).toBe("New Title 2.md");
    expect(note._content).toContain("fresh");
    expect(note._content).toContain("Summary.");
    expect(getNoticeMessages()).toEqual(["Tidied New Title 2."]);
  });

  it("keeps an existing summary and skips declined parts of the decision", async () => {
    const { app, flows } = rig();
    const note = app.vault.seed("Doc.md", "---\nsummary: Mine\n---\nbody", { frontmatter: { summary: "Mine" } });
    tagger.summarizeAndTag.mockResolvedValue({ title: "Doc", tags: ["fresh"], newTags: [], summary: "Other." });
    ui.decision = { accepted: [], frontmatter: false, rename: false };
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true, frontmatter: true });
    expect(ui.proposals[0]).toMatchObject({ frontmatter: { summary: "", addedTags: ["fresh"] } });
    expect((ui.proposals[0] as { rename?: unknown }).rename).toBeUndefined();
    expect(note.path).toBe("Doc.md");
    expect(note._content).toBe("---\nsummary: Mine\n---\nbody");
  });

  it("applies accepted copyedit and link hunks to the note body", async () => {
    const { app, flows } = rig();
    app.vault.seed("Notes/Atlas.md", "");
    const note = app.vault.seed("Notes/Doc.md", "We met Atlas today.");
    lint.parseLintResponse.mockImplementation((_text: string, body: string) => body.replace("today", "yesterday"));
    ui.decision = { accepted: [true], frontmatter: false, rename: false };
    await flows.enrichNoteFlow(note, { ...OPTIONS, links: true, lint: true });
    expect(note._content).toBe("We met [[Atlas]] yesterday.");
    expect(getNoticeMessages()).toEqual(["Tidied Doc."]);
  });

  it("keeps going when the copyedit pass fails", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Notes/Doc.md", "text");
    complete.mockRejectedValue(new Error("model down"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
    expect(getNoticeMessages()).toEqual(["Doc is already in good shape."]);
  });

  it("writes nothing when the review is dismissed", async () => {
    const { app, flows } = rig();
    const note = app.vault.seed("Notes/Doc.md", "body");
    tagger.summarizeAndTag.mockResolvedValue({ title: "Renamed", tags: [], newTags: [], summary: "" });
    ui.decision = null;
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(note.path).toBe("Notes/Doc.md");
    expect(getNoticeMessages()).toEqual([]);
  });

  it("ignores a failed best-effort tagging pass but stops on an unavailable utility model", async () => {
    const { app, flows, activity } = rig();
    const note = app.vault.seed("Notes/Doc.md", "body");
    tagger.summarizeAndTag.mockRejectedValueOnce(new Error("bad json"));
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(getNoticeMessages()).toEqual(["Doc is already in good shape."]);

    clearNotices();
    tagger.summarizeAndTag.mockRejectedValueOnce(new UtilityUnavailableError("Utility model is not available.", {} as never));
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(getNoticeMessages()).toEqual(["Tidy failed — Utility model is not available."]);
    expect(activity.snapshot().records.some((r) => r.state === "needs-attention")).toBe(true);
  });
});

describe("NoteFlows enrichFolderFlow", () => {
  function folder(children: Array<TFile | TFolder>, path = "Notes"): TFolder {
    return Object.assign(new TFolder(path), { children });
  }

  it("reports an empty folder without opening the step picker", async () => {
    const { flows } = rig();
    await flows.enrichFolderFlow(folder([new TFile("Notes/a.pdf", "", 0)]));
    expect(getNoticeMessages()).toEqual(["No notes found in Notes/."]);
    expect(ui.optionCounts).toEqual([]);
  });

  it("does nothing when the step picker is dismissed", async () => {
    const { flows } = rig();
    const spy = vi.spyOn(flows, "enrichNoteFlow");
    await flows.enrichFolderFlow(folder([new TFile("Notes/a.md", "", 0)]));
    expect(ui.optionCounts).toEqual([1]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("walks subfolders and tidies each markdown note in order with the chosen steps", async () => {
    const { flows } = rig();
    const a = new TFile("Notes/a.md", "", 0);
    const b = new TFile("Notes/sub/b.md", "", 0);
    const spy = vi.spyOn(flows, "enrichNoteFlow").mockResolvedValue(undefined);
    ui.options = OPTIONS;
    await flows.enrichFolderFlow(folder([a, new TFile("Notes/skip.txt", "", 0), folder([b], "Notes/sub")]));
    expect(ui.optionCounts).toEqual([2]);
    expect(spy.mock.calls).toEqual([[a, OPTIONS], [b, OPTIONS]]);
  });
});

describe("NoteFlows suggestFrontmatterForActiveNote", () => {
  it("asks for a markdown note and refuses an empty one", async () => {
    const { app, flows, complete } = rig();
    await flows.suggestFrontmatterForActiveNote();
    setActive(app, app.vault.seed("Notes/Empty.md", "   \n"));
    await flows.suggestFrontmatterForActiveNote();
    expect(getNoticeMessages()).toEqual(["Open a note to suggest frontmatter for.", "This note is empty — nothing to describe."]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("previews additive tags and summary, then writes them on apply without clobbering set fields", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Notes/Doc.md", "---\ntype: note\ntags:\n  - mine\n---\nbody", { frontmatter: { type: "note", tags: ["mine"] } });
    setActive(app, note);
    complete.mockResolvedValue({ text: "TYPE: project\nTAGS: alpha, mine\nSUMMARY: A note.", provider: { label: "Utility" } });
    ui.apply = true;
    await flows.suggestFrontmatterForActiveNote();
    await vi.waitFor(() => expect(getNoticeMessages()).toContain("Frontmatter updated: Doc"));
    expect(complete).toHaveBeenCalledWith("utility", expect.objectContaining({ maxTokens: 200, user: expect.stringContaining("Document:\n\n---\ntype: note") }));
    expect(ui.frontmatter[0]).toMatchObject({ basename: "Doc", label: "Utility", proposal: { tags: ["mine", "alpha"], newTags: ["alpha"], summary: "A note." } });
    expect(ui.frontmatter[0]!.proposal.type).toBeUndefined();
    expect(note._content).toContain('type: "note"');
    expect(note._content).toContain("alpha");
    expect(note._content).toContain("A note.");
  });

  it("offers ontology types to the model and writes nothing when the preview is declined", async () => {
    const { app, flows, complete, settings } = rig({ ontology: ["project", "person"] });
    settings.ontologyEnabled = true;
    const note = app.vault.seed("Notes/Doc.md", "body");
    setActive(app, note);
    complete.mockResolvedValue({ text: "TYPE: project\nTAGS: alpha\nSUMMARY: S.", provider: { label: "Utility" } });
    ui.apply = false;
    await flows.suggestFrontmatterForActiveNote();
    expect(complete.mock.calls[0]![1].system).toContain("project, person");
    expect(ui.frontmatter[0]!.proposal.type).toBe("project");
    expect(note._content).toBe("body");
    expect(getNoticeMessages()).toEqual([]);
  });

  it("truncates a long note and reports a model failure", async () => {
    const { app, flows, complete, activity } = rig();
    const note = app.vault.seed("Notes/Long.md", "x".repeat(9000));
    setActive(app, note);
    complete.mockRejectedValue(new Error("offline"));
    await flows.suggestFrontmatterForActiveNote();
    expect(complete.mock.calls[0]![1].user.endsWith("\n…[truncated]")).toBe(true);
    expect(getNoticeMessages()).toEqual(["Couldn't suggest frontmatter: offline"]);
    expect(activity.snapshot().records.some((r) => r.state === "needs-attention")).toBe(true);
  });
});
