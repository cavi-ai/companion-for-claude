import { App, TFile, TFolder, clearNotices, getNoticeMessages, parseYaml } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { NoteFlows } from "../../src/enrich/noteFlows";
import { readFrontmatter, stripFrontmatter } from "../../src/markdown/frontmatter";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";

const ui = vi.hoisted(() => ({
  options: null as unknown,
  decision: null as unknown,
  accepted: null as boolean[] | null,
  batch: null as unknown,
  apply: false,
  onReview: null as (() => void) | null,
  onFrontmatter: null as (() => void) | null,
  optionCounts: [] as number[],
  proposals: [] as unknown[],
  diffs: [] as Array<{ path: string; description: string }>,
  frontmatter: [] as Array<{ basename: string; proposal: Record<string, unknown>; label: string }>,
}));
const tagger = vi.hoisted(() => ({ summarizeAndTag: vi.fn() }));

vi.mock("../../src/indexing/autoTagger", () => tagger);
vi.mock("../../src/view/EnrichModal", () => ({
  EnrichOptionsModal: class {
    constructor(_app: unknown, private count: number, private resolve: (value: unknown) => void) {}
    open(): void { ui.optionCounts.push(this.count); this.resolve(ui.options); }
  },
  EnrichReviewModal: class {
    constructor(_app: unknown, private proposal: unknown, private resolve: (value: unknown) => void) {}
    open(): void { ui.proposals.push(this.proposal); ui.onReview?.(); this.resolve(ui.decision); }
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
      ui.onFrontmatter?.();
      void this.cb(ui.apply);
    }
  },
}));

const OPTIONS = { rename: false, frontmatter: false, links: false, lint: false, autoApply: false };
const LINT_FIX = { text: JSON.stringify({ complete: true, edits: [{ old_str: "Original", new_str: "Corrected" }] }), provider: { label: "Utility" } };

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
  const complete = vi.fn(async (requestRole: string, request: { system: string }) => ({ text: request.system.includes("meticulous markdown copyeditor") ? JSON.stringify({ complete: true, edits: [] }) : "TYPE: -\nTAGS: alpha, beta\nSUMMARY: A note.", provider: { label: "Utility" } }));
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
  ui.onReview = null; ui.onFrontmatter = null;
  ui.optionCounts.length = 0; ui.proposals.length = 0; ui.diffs.length = 0; ui.frontmatter.length = 0;
  tagger.summarizeAndTag.mockReset();
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
  it("keeps review activity pending and reports a failed apply", async () => {
    const { app, flows, activity } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    tagger.summarizeAndTag.mockResolvedValue({ title: "Doc", tags: ["fresh"], newTags: [], summary: "Summary." });
    let reviewState: string | undefined;
    ui.onReview = () => { reviewState = activity.snapshot().records[0]?.state; };
    ui.decision = { accepted: [], frontmatter: true, rename: false };
    vi.spyOn(app.fileManager, "processFrontMatter").mockRejectedValue(new Error("vault locked"));
    await flows.enrichNoteFlow(note, { ...OPTIONS, frontmatter: true });
    expect(reviewState).toBe("running");
    expect(activity.snapshot().records[0]?.state).toBe("needs-attention");
    expect(getNoticeMessages()).toContain("Tidy failed — vault locked");
    expect(note._content).toBe("Original body.");
  });

  it.each([{ tags: ["keep", "user-added"] }, { tags: "user-added" }, { tags: [] }])("merges reviewed tag additions into current tags %j without replacing a newer summary", async ({ tags: currentTags }) => {
    const { app, flows } = rig();
    const note = app.vault.seed("Doc.md", "body", { frontmatter: { tags: ["keep", "removed"] } });
    tagger.summarizeAndTag.mockResolvedValue({ title: "Doc", tags: ["keep", "fresh"], newTags: ["fresh"], summary: "Generated summary." });
    ui.decision = { accepted: [], frontmatter: true, rename: false };
    const current = { tags: currentTags, summary: "My newer summary.", keep: true };
    vi.spyOn(app.fileManager, "processFrontMatter").mockImplementation(async (_file, update) => { update(current); });
    await flows.enrichNoteFlow(note, { ...OPTIONS, frontmatter: true });
    const tags = typeof currentTags === "string" ? [currentTags] : currentTags;
    expect(current).toEqual({ tags: [...tags, "fresh"], summary: "My newer summary.", keep: true, tidied: ["frontmatter"], tidy_hash: expect.stringMatching(/^fnv1a-/) });
  });

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

  it("reports no changes when copyediting completed with an unchanged reply", async () => {
    const { app, flows, activity } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(getNoticeMessages()).toEqual(["Doc is already in good shape."]);
    expect(activity.snapshot().records[0]?.state).toBe("succeeded");
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
    expect(readFrontmatter(note._content, parseYaml)).toEqual({ summary: "Mine", tidied: ["rename", "frontmatter"], tidy_hash: expect.stringMatching(/^fnv1a-/) });
    expect(stripFrontmatter(note._content).trim()).toBe("body");
  });

  it("reports a failed copyedit without claiming the note passed its checks", async () => {
    const { app, flows, complete, activity } = rig();
    const note = app.vault.seed("Notes/Doc.md", "text");
    complete.mockRejectedValue(new Error("model down"));
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(getNoticeMessages().join("\n")).toContain("Lint note: model down");
    expect(getNoticeMessages().join("\n")).not.toContain("already in good shape");
    expect(note._content).toBe("text");
    expect(activity.snapshot().records[0]?.state).toBe("needs-attention");
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

  it("reports an unavailable utility model when no supported step was selected", async () => {
    const { app, flows, activity } = rig();
    const note = app.vault.seed("Notes/Doc.md", "body");
    tagger.summarizeAndTag.mockRejectedValueOnce(new Error("bad json"));
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(getNoticeMessages().join("\n")).toContain("Rename note: bad json");
    expect(getNoticeMessages().join("\n")).not.toContain("already in good shape");

    clearNotices();
    tagger.summarizeAndTag.mockRejectedValueOnce(new UtilityUnavailableError("Utility model is not available.", {} as never));
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(getNoticeMessages().join("\n")).toContain("Rename note: Utility model is not available.");
    expect(activity.snapshot().records.some((r) => r.state === "needs-attention")).toBe(true);
  });

  it.each([true, false])("keeps valid copyedits reviewable when tagging fails (apply: %s)", async (apply) => {
    const { app, flows, activity, complete } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    tagger.summarizeAndTag.mockRejectedValue(new Error("tag service unavailable"));
    complete.mockResolvedValue({ text: JSON.stringify({ complete: true, edits: [{ old_str: "Original", new_str: "Corrected" }] }), provider: { label: "Utility" } });
    ui.decision = apply ? { accepted: [true], frontmatter: false, rename: false } : null;
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true, frontmatter: true, lint: true });
    expect(ui.proposals[0]).toMatchObject({ failures: [{ step: "Rename note / Tags & summary", message: "tag service unavailable" }], plan: { hunks: expect.any(Array) } });
    if (apply) {
      expect(readFrontmatter(note._content, parseYaml)).toEqual({ tidied: ["lint"], tidy_hash: expect.stringMatching(/^fnv1a-/) });
      expect(stripFrontmatter(note._content).trim()).toBe("Corrected body.");
    } else {
      expect(note._content).toBe("Original body.");
    }
    expect(activity.snapshot().records[0]?.state).toBe("needs-attention");
    expect(getNoticeMessages().join("\n")).not.toContain("Tidied Doc.");
    if (apply) expect(getNoticeMessages().join("\n")).toContain("Some Tidy steps failed");
  });

  it("preserves valid metadata proposals when copyediting fails", async () => {
    const { app, flows, complete, activity } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    tagger.summarizeAndTag.mockResolvedValue({ title: "Renamed", tags: ["fresh"], newTags: ["fresh"], summary: "Summary." });
    complete.mockRejectedValue(new Error("copyeditor unavailable"));
    ui.decision = null;
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true, frontmatter: true, lint: true });
    expect(ui.proposals[0]).toMatchObject({ rename: { to: "Renamed.md" }, frontmatter: { tags: ["fresh"] }, failures: [{ step: "Lint note", message: "copyeditor unavailable" }] });
    expect(note._content).toBe("Original body.");
    expect(activity.snapshot().records[0]?.state).toBe("needs-attention");
  });

  it("reports every failed pass when no proposal can be reviewed", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    tagger.summarizeAndTag.mockRejectedValue(new Error("tag service unavailable"));
    complete.mockRejectedValue(new Error("copyeditor unavailable"));
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true, lint: true });
    expect(ui.proposals).toEqual([]);
    expect(getNoticeMessages().join("\n")).toContain("Rename note: tag service unavailable");
    expect(getNoticeMessages().join("\n")).toContain("Lint note: copyeditor unavailable");
    expect(note._content).toBe("Original body.");
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
    const a = new TFile("Notes/a.md", "A.", 0);
    const b = new TFile("Notes/sub/b.md", "B.", 0);
    const spy = vi.spyOn(flows, "enrichNoteFlow").mockResolvedValue(undefined);
    ui.options = OPTIONS;
    await flows.enrichFolderFlow(folder([a, new TFile("Notes/skip.txt", "", 0), folder([b], "Notes/sub")]));
    expect(ui.optionCounts).toEqual([2]);
    expect(spy.mock.calls).toEqual([[a, OPTIONS], [b, OPTIONS]]);
  });

  it("skips a note a previous Tidy finished while its text is unchanged", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Notes/a.md", "Original body.");
    const fresh = app.vault.seed("Notes/b.md", "Other body.");
    tagger.summarizeAndTag.mockResolvedValue({ title: "a", tags: ["fresh"], newTags: [], summary: "Summary." });
    complete.mockResolvedValue(LINT_FIX);
    ui.options = { ...OPTIONS, frontmatter: true, lint: true };
    ui.decision = { accepted: [true], frontmatter: true, rename: false };
    await flows.enrichFolderFlow(folder([note]));
    expect(note._content).toContain("Corrected body.");
    expect(tagger.summarizeAndTag).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);

    clearNotices();
    await flows.enrichFolderFlow(folder([note, fresh]));
    expect(tagger.summarizeAndTag).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(ui.proposals.map((p) => (p as { path: string }).path)).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(getNoticeMessages()).toContain("Skipped 1 note already tidied.");
  });
});

describe("Tidy leaves empty notes alone", () => {
  it("sends nothing to the model for a note without a body, alone or in a folder", async () => {
    const { app, flows, complete } = rig();
    const empty = app.vault.seed("Notes/Empty.md", "---\ntags: [draft]\n---\n");
    const body = app.vault.seed("Notes/Body.md", "Original body.");
    await flows.enrichNoteFlow(empty, { ...OPTIONS, frontmatter: true, lint: true });
    expect(getNoticeMessages()).toEqual(["Empty is empty."]);

    clearNotices();
    ui.options = { ...OPTIONS, lint: true };
    await flows.enrichFolderFlow(Object.assign(new TFolder("Notes"), { children: [empty, body] }));
    expect(tagger.summarizeAndTag).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(getNoticeMessages()).toContain("Skipped 1 empty note.");
    expect(empty._content).toBe("---\ntags: [draft]\n---\n");
  });
});

describe("Tidy skips work already done", () => {
  it("skips an unchanged note and tidies it again after its text changes", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Doc.md", "Body.");
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(complete).toHaveBeenCalledTimes(1);
    await app.vault.modify(note, `${note._content}\n\nA new paragraph.`);
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("runs only the steps a previous Tidy did not finish, then reports the note as done", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Doc.md", "Body.");
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    tagger.summarizeAndTag.mockResolvedValue({ title: "Doc", tags: ["fresh"], newTags: [], summary: "Summary." });
    ui.decision = { accepted: [], frontmatter: true, rename: false };
    await flows.enrichNoteFlow(note, { ...OPTIONS, frontmatter: true, lint: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(tagger.summarizeAndTag).toHaveBeenCalledTimes(1);
    expect(note._content).toContain("fresh");

    clearNotices();
    await flows.enrichNoteFlow(note, { ...OPTIONS, frontmatter: true, lint: true });
    expect(getNoticeMessages()).toEqual(["Doc is already tidied."]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(tagger.summarizeAndTag).toHaveBeenCalledTimes(1);
  });

  it("retries a failed step and skips it once it succeeds", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Doc.md", "Body.");
    complete.mockRejectedValueOnce(new Error("model down"));
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(note._content).toBe("Body.");
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    await flows.enrichNoteFlow(note, { ...OPTIONS, lint: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("proposes again after a dismissed review and skips once the review is applied", async () => {
    const { app, flows } = rig();
    const note = app.vault.seed("Doc.md", "body");
    tagger.summarizeAndTag.mockResolvedValue({ title: "Renamed", tags: [], newTags: [], summary: "" });
    ui.decision = null;
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(note._content).toBe("body");
    ui.decision = { accepted: [], frontmatter: false, rename: false };
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true });
    expect(tagger.summarizeAndTag).toHaveBeenCalledTimes(2);
    expect(note.path).toBe("Doc.md");
  });
});

describe("Tidy auto-apply", () => {
  it("applies every proposed change without opening the review", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    tagger.summarizeAndTag.mockResolvedValue({ title: "New Title", tags: ["fresh"], newTags: ["fresh"], summary: "Summary." });
    complete.mockResolvedValue(LINT_FIX);
    await flows.enrichNoteFlow(note, { ...OPTIONS, rename: true, frontmatter: true, lint: true, autoApply: true });
    expect(ui.proposals).toEqual([]);
    expect(note.path).toBe("New Title.md");
    expect(note._content).toContain("Corrected body.");
    expect(note._content).toContain("fresh");
    expect(note._content).toContain("Summary.");
    expect(getNoticeMessages()).toEqual(["Tidied New Title."]);
  });
});

describe("Inbox link auto-apply", () => {
  it("links every suggested mention without the batch review when enrichment auto-apply is on", async () => {
    const { app, flows, settings } = rig();
    settings.enrichAutoApply = true;
    app.vault.seed("Notes/Atlas.md", "");
    const clip = app.vault.seed("Clippings/clip.md", "Atlas is mentioned.");
    ui.batch = null;
    const result = await flows.reviewInboxLinkSuggestions([clip]);
    expect(result).toMatchObject({ appliedFiles: 1, appliedHunks: 1 });
    expect(clip._content).toBe("[[Atlas]] is mentioned.");
  });
});

describe("NoteFlows suggestFrontmatterForActiveNote", () => {
  it("owns the review through apply and reports write failures", async () => {
    const { app, flows, activity } = rig();
    const note = app.vault.seed("Doc.md", "Original body.");
    setActive(app, note);
    let reviewState: string | undefined;
    ui.onFrontmatter = () => { reviewState = activity.snapshot().records[0]?.state; };
    ui.apply = true;
    vi.spyOn(app.fileManager, "processFrontMatter").mockRejectedValue(new Error("vault locked"));
    await flows.suggestFrontmatterForActiveNote();
    expect(reviewState).toBe("running");
    expect(getNoticeMessages()).toContain("Couldn't apply frontmatter: vault locked");
    expect(activity.snapshot().records[0]?.state).toBe("needs-attention");
    expect(note._content).toBe("Original body.");
  });

  it("preserves tag additions, removals and scalar fields changed while the preview is open", async () => {
    const { app, flows, complete } = rig();
    const note = app.vault.seed("Doc.md", "body", { frontmatter: { tags: ["keep", "removed"] } });
    setActive(app, note);
    complete.mockResolvedValue({ text: "TYPE: project\nTAGS: fresh\nSUMMARY: Generated summary.", provider: { label: "Utility" } });
    ui.apply = true;
    const current = { type: "person", tags: ["keep", "user-added"], summary: "My newer summary.", keep: true };
    vi.spyOn(app.fileManager, "processFrontMatter").mockImplementation(async (_file, update) => { update(current); });
    await flows.suggestFrontmatterForActiveNote();
    await vi.waitFor(() => expect(getNoticeMessages()).toContain("Frontmatter updated: Doc"));
    expect(current).toEqual({ type: "person", tags: ["keep", "user-added", "fresh"], summary: "My newer summary.", keep: true });
  });

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

describe("note review ownership", () => {
  it.each(["Tidy", "frontmatter"])("does not apply an old %s proposal to a replacement note at the same path", async (action) => {
    const { app, flows, activity } = rig();
    const original = app.vault.seed("Doc.md", "Original body.");
    setActive(app, original);
    tagger.summarizeAndTag.mockResolvedValue({ title: "Doc", tags: ["fresh"], newTags: [], summary: "Summary." });
    const replace = () => { app.vault.seed("Doc.md", "Replacement body."); };
    ui.onReview = replace;
    ui.onFrontmatter = replace;
    ui.apply = true;
    ui.decision = { accepted: [], frontmatter: true, rename: false };
    const write = vi.spyOn(app.fileManager, "processFrontMatter");
    if (action === "Tidy") await flows.enrichNoteFlow(original, { ...OPTIONS, frontmatter: true });
    else await flows.suggestFrontmatterForActiveNote();
    expect(write).not.toHaveBeenCalled();
    expect(await app.vault.read(app.vault.getAbstractFileByPath("Doc.md") as TFile)).toBe("Replacement body.");
    expect(getNoticeMessages().join("\n")).toContain("no longer available");
    expect(activity.snapshot().records[0]?.state).toBe("needs-attention");
  });
});
