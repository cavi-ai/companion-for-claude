import { describe, expect, it, vi } from "vitest";
import { getLastOpenedModal, WorkspaceLeaf } from "obsidian";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";
import { ResearchActions } from "../../src/view/research/actions";
import { ProjectCreateModal } from "../../src/view/research/projectCreateModal";

const project = { path: "R/P/Project.md", title: "P", type: "research-project", project: "R/P/Project.md", question: "Does it?", stage: "read", status: "active" } as const;
const source: ResearchRecord = { path: "R/P/Sources/S.md", title: "S", type: "research-source", project: project.path, sourceKind: "web", contentFingerprint: "new", capturedContent: "Intro text. Different wording now. Outro text." };
const ev = (name: string, extra: Record<string, unknown> = {}): ResearchRecord => ({ path: `R/P/Evidence/${name}.md`, title: name, type: "evidence", project: project.path, source: source.path, excerpt: `Passage ${name}`, locatorKind: "page", locatorValue: "4", reviewState: "reviewed", sourceFingerprint: "new", ...extra }) as ResearchRecord;
const claim = (name: string, extra: Record<string, unknown> = {}): ResearchRecord => ({ path: `R/P/Claims/${name}.md`, title: name, type: "claim", project: project.path, proposition: "It does.", confidence: "moderate", reviewState: "proposed", supports: [], challenges: [], contextualizes: [], limitations: [], ...extra }) as ResearchRecord;
const snap = (records: ResearchRecord[]) => buildProjectSnapshot(project.path, [project, source, ...records], []);

function setup(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const repository = {
    updateEvidenceLocator: vi.fn(async (...a: unknown[]) => { calls.push(`locator:${a[1]}:${a[2]}`); }),
    updateEvidenceInterpretation: vi.fn(async () => { calls.push("interpretation"); }),
    reviewEvidence: vi.fn(async (_p: string, state: string) => { calls.push(`review:${state}`); }),
    linkClaimEvidence: vi.fn(async (...a: unknown[]) => { calls.push(`link:${a[2]}:${a[3]}`); }),
    reviewClaim: vi.fn(async (...a: unknown[]) => { calls.push(`claim:${a[1]}:${a[2] ?? ""}`); }),
    createClaim: vi.fn(async () => ({ path: "R/P/Claims/New.md" })),
  };
  const changed = vi.fn(async () => undefined);
  const actions = new ResearchActions({ app: new WorkspaceLeaf().app, repository: repository as never, openPath: async () => undefined, changed, selectProject: async () => undefined, ...overrides } as never);
  return { actions, repository, calls, changed };
}
const modal = () => getLastOpenedModal()!;
const all = (selector: string): any[] => [...modal().contentEl.querySelectorAll(selector)];
const byLabel = (label: string) => ["input", "textarea", "select"].flatMap((tag) => all(tag)).find((el) => el.getAttribute("aria-label") === label);
const button = (text: string) => all("button").find((el) => el.textContent === text);
const click = (el: any) => el.dispatchEvent({ type: "click" });
const type = (el: any, value: string) => { el.value = value; el.dispatchEvent({ type: "input" }); };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("evidence review", () => {
  it("opens the passage the Desk named, not the first proposed one", () => {
    const { actions } = setup();
    actions.reviewEvidence(snap([ev("First", { reviewState: "proposed" }), ev("Named", { reviewState: "reviewed", sourceFingerprint: "old" })]), "R/P/Evidence/Named.md");
    expect(all("h2")[0].textContent).toBe("Check Named");
  });

  it("shows the changed-source banner and the passage's absence", () => {
    const { actions } = setup();
    actions.reviewEvidence(snap([ev("Named", { sourceFingerprint: "old" })]), "R/P/Evidence/Named.md");
    const texts = all("p").map((el) => el.textContent);
    expect(texts).toContain("The source changed since this was checked. Confirm the passage still says this.");
    expect(texts).toContain("This passage no longer appears in the source.");
  });

  it("shows surrounding text when the passage is still in the source", () => {
    const { actions } = setup();
    actions.reviewEvidence(snap([ev("Named", { sourceFingerprint: "old", excerpt: "Different wording now." })]), "R/P/Evidence/Named.md");
    expect(all("p").map((el) => el.textContent).some((text) => text?.includes("Intro text. Different wording now. Outro text."))).toBe(true);
  });

  it("Keep writes a changed locator before reviewing", async () => {
    const { actions, calls, changed } = setup();
    actions.reviewEvidence(snap([ev("E", { reviewState: "proposed", locatorKind: undefined, locatorValue: undefined })]));
    byLabel("Locator type").value = "section";
    type(byLabel("Locator value"), "Methods");
    click(button("Keep"));
    await settle();
    expect(calls).toEqual(["locator:section:Methods", "review:reviewed"]);
    expect(changed).toHaveBeenCalled();
  });

  it("drafts the interpretation on open without overwriting typed text", async () => {
    let resolve!: (value: string) => void;
    const rewriteText = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const { actions } = setup({ rewriteText, researchLabel: () => "Claude Code · sonnet" });
    actions.reviewEvidence(snap([ev("E", { reviewState: "proposed" })]));
    expect(all("p").map((el) => el.textContent)).toContain("Drafting with Claude Code · sonnet…");
    type(byLabel("Evidence interpretation"), "My own reading");
    resolve("Drafted reading");
    await settle();
    expect(byLabel("Evidence interpretation").value).toBe("My own reading");
  });
});

describe("claim review", () => {
  it("links checked passages then reviews with the limitation", async () => {
    const { actions, calls } = setup();
    actions.reviewClaim(snap([ev("A"), ev("B"), claim("C", { challenges: ["R/P/Evidence/B.md"] })]), "R/P/Claims/C.md");
    expect(all("h4").map((el) => el.textContent)).toEqual(expect.arrayContaining(["Challenges", "Link a passage that supports it"]));
    click(byLabel("Link A"));
    byLabel("Link A").checked = true;
    type(byLabel("What this claim doesn't cover"), "Adults only");
    click(button("Mark reviewed"));
    await settle();
    expect(calls).toEqual(["link:R/P/Evidence/A.md:supports", "claim:reviewed:Adults only"]);
  });

  it("drafts the limitation when challenged and none is written", async () => {
    const rewriteText = vi.fn(async () => "Does not cover children.");
    const { actions } = setup({ rewriteText });
    actions.reviewClaim(snap([ev("B"), claim("C", { challenges: ["R/P/Evidence/B.md"] })]), "R/P/Claims/C.md");
    await settle();
    expect(byLabel("What this claim doesn't cover").value).toBe("Does not cover children.");
  });
});

describe("claim creation", () => {
  const suggestion = JSON.stringify({ title: "Drafted title", proposition: "Drafted proposition.", confidence: "high", relations: [{ evidence: "R/P/Evidence/A.md", relation: "supports" }] });

  it("fills only the fields the user has not touched", async () => {
    let resolve!: (value: string) => void;
    const completeResearch = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const { actions } = setup({ completeResearch, researchLabel: () => "Claude Code · sonnet" });
    actions.createClaim(snap([ev("A")]));
    expect(all("p").map((el) => el.textContent)).toContain("Drafting a claim with Claude Code · sonnet…");
    type(byLabel("Short title"), "My title");
    resolve(suggestion);
    await settle();
    expect(byLabel("Short title").value).toBe("My title");
    expect(byLabel("Claim").value).toBe("Drafted proposition.");
    expect(byLabel("Claim confidence").value).toBe("high");
    expect(byLabel("A supports").checked).toBe(true);
  });

  it("falls back to a manual form when drafting fails", async () => {
    const completeResearch = vi.fn(async () => { throw new Error("Research AI is off."); });
    const { actions } = setup({ completeResearch });
    actions.createClaim(snap([ev("A")]));
    await settle();
    expect(all("p").map((el) => el.textContent)).toEqual(expect.arrayContaining(["Couldn't draft a claim. Fill it in below.", "Research AI is off."]));
    expect(button("Suggest again")).toBeDefined();
  });

  it("creates what the user filled in", async () => {
    const { actions, repository } = setup();
    actions.createClaim(snap([ev("A")]));
    type(byLabel("Short title"), "Mine");
    type(byLabel("Claim"), "It does.");
    byLabel("A supports").checked = true;
    click(button("Create claim"));
    await settle();
    expect(repository.createClaim).toHaveBeenCalledWith(expect.objectContaining({ title: "Mine", reviewState: "reviewed", supports: ["R/P/Evidence/A.md"] }));
  });
});

describe("project creation", () => {
  it("drafts the question when the title loses focus, never over typed text", async () => {
    const rewriteText = vi.fn(async () => "Does X affect Y?");
    new ProjectCreateModal(new WorkspaceLeaf().app, async () => undefined, rewriteText).open();
    byLabel("Project title").value = "X and Y";
    byLabel("Project title").dispatchEvent({ type: "blur" });
    await settle();
    expect(byLabel("Research question").value).toBe("Does X affect Y?");
    byLabel("Research question").value = "Typed";
    byLabel("Project title").dispatchEvent({ type: "blur" });
    await settle();
    expect(rewriteText).toHaveBeenCalledTimes(1);
    expect(byLabel("Research question").value).toBe("Typed");
  });
});

describe("desk actions", () => {
  it("runs a step by kind", async () => {
    const { actions } = setup();
    await actions.runStep({ kind: "extract", label: "Pull passages", path: "R/P/Sources/S.md" } as never, snap([]));
    expect(all("h2")[0].textContent).toBe("Pull passages from a source");
  });


  it("routes every other step kind to its action", async () => {
    const { actions } = setup();
    const target = snap([ev("E"), claim("C")]);
    const spies = {
      reviewClaim: vi.spyOn(actions, "reviewClaim").mockImplementation(() => undefined),
      reviewEvidence: vi.spyOn(actions, "reviewEvidence").mockImplementation(() => undefined),
      addSource: vi.spyOn(actions, "addSource").mockImplementation(() => undefined),
      buildOutline: vi.spyOn(actions, "buildOutline").mockImplementation(() => undefined),
    };
    await actions.runStep({ kind: "check", label: "Check C", path: "R/P/Claims/C.md" } as never, target);
    expect(spies.reviewClaim).toHaveBeenCalledWith(target, "R/P/Claims/C.md");
    expect(spies.reviewEvidence).not.toHaveBeenCalled();
    await actions.runStep({ kind: "check", label: "Check E", path: "R/P/Evidence/E.md" } as never, target);
    expect(spies.reviewEvidence).toHaveBeenCalledWith(target, "R/P/Evidence/E.md");
    await actions.runStep({ kind: "add-source", label: "Add a source" } as never, target);
    expect(spies.addSource).toHaveBeenCalledWith(project.path);
    await actions.runStep({ kind: "build-outline", label: "Build the outline" } as never, target);
    expect(spies.buildOutline).toHaveBeenCalledWith(target);
  });
});

describe("extract evidence modal", () => {
  const reply = JSON.stringify({ passages: [
    { title: "Opening", excerpt: "Intro text.", interpretation: "It opens." },
    { title: "Invented", excerpt: "Never written anywhere." },
    { title: "Closing", excerpt: "Outro text." },
  ] });
  const sourceText = async (item: { capturedContent?: string }) => item.capturedContent ? { text: item.capturedContent } : null;

  it("renders checked passages with computed locators and counts the checked ones", async () => {
    const { actions } = setup({ sourceText, completeResearch: async () => reply, researchLabel: () => "Test model" });
    actions.extractEvidence(snap([]));
    await settle();
    expect(all("blockquote").map((el) => el.textContent)).toEqual(["Intro text.", "Outro text."]);
    expect(button("Add 2 passages")).toBeDefined();
    expect(all("select").filter((el) => el.getAttribute("aria-label") === "Where it is: type")[0].value).toBe("paragraph");
    const closing = all("input").find((el) => el.getAttribute("aria-label") === "Add Closing");
    closing.checked = false;
    closing.dispatchEvent({ type: "change" });
    expect(button("Add 1 passage")).toBeDefined();
  });

  it("adds reviewed passages with the model label and closes", async () => {
    const { actions, repository, changed } = setup({ sourceText, completeResearch: async () => reply, researchLabel: () => "Test model" });
    (repository as any).createEvidence = vi.fn(async () => ({ path: "R/P/Evidence/X.md" }));
    actions.extractEvidence(snap([]));
    await settle();
    click(button("Add 2 passages"));
    await settle();
    expect((repository as any).createEvidence).toHaveBeenCalledTimes(2);
    expect((repository as any).createEvidence).toHaveBeenCalledWith(expect.objectContaining({ project: project.path, source: source.path, title: "Opening", excerpt: "Intro text.", locatorKind: "paragraph", locatorValue: "1", interpretation: "It opens.", reviewState: "reviewed", model: "Test model" }));
    expect(changed).toHaveBeenCalled();
    expect(modal().closed).toBe(true);
  });

  it("creates a manual passage without a location as proposed", async () => {
    const { actions, repository } = setup({ sourceText: async () => null });
    (repository as any).createEvidence = vi.fn(async () => ({ path: "R/P/Evidence/X.md" }));
    actions.extractEvidence(snap([]));
    await settle();
    expect(all("p").map((el) => el.textContent)).toContain("This source has no text to read. Open it, copy the passage, and paste it below.");
    type(byLabel("Your passage"), "Pasted by hand here");
    expect(byLabel("Passage title").value).toBe("Pasted by hand here");
    click(button("Add 1 passage"));
    await settle();
    expect((repository as any).createEvidence).toHaveBeenCalledWith(expect.objectContaining({ excerpt: "Pasted by hand here", reviewState: "proposed" }));
  });

  it("shows the manual path when the call fails", async () => {
    const { actions } = setup({ sourceText, completeResearch: async () => { throw new Error("offline"); } });
    actions.extractEvidence(snap([]));
    await settle();
    const texts = all("p").map((el) => el.textContent);
    expect(texts).toContain("Couldn't read this source automatically. Add a passage yourself below.");
    expect(texts).toContain("offline");
  });

  it("keeps failed passages checked and the modal open", async () => {
    const { actions, repository } = setup({ sourceText, completeResearch: async () => reply });
    (repository as any).createEvidence = vi.fn(async (input: { title: string }) => { if (input.title === "Closing") throw new Error("write failed"); return {}; });
    actions.extractEvidence(snap([]));
    await settle();
    click(button("Add 2 passages"));
    await settle();
    expect(modal().closed).toBe(false);
    expect(all("p").map((el) => el.textContent).join(" ")).toContain("write failed");
    expect(all("blockquote").map((el) => el.textContent)).toEqual(["Outro text."]);
    expect(button("Add 1 passage")).toBeDefined();
  });
});

describe("evidence review draft retry", () => {
  it("shows the reason and re-runs the draft without overwriting typed text", async () => {
    let calls = 0;
    const rewriteText = vi.fn(async () => { calls++; if (calls === 1) throw new Error("rate limited"); return "Second draft"; });
    const { actions } = setup({ rewriteText });
    actions.reviewEvidence(snap([ev("E", { reviewState: "proposed" })]));
    await settle();
    expect(all("p").map((el) => el.textContent).join(" ")).toContain("rate limited");
    click(button("Draft again"));
    await settle();
    expect(byLabel("Evidence interpretation").value).toBe("Second draft");
    expect(rewriteText).toHaveBeenCalledTimes(2);
  });
});
