import { App, FakeElement, getNoticeMessages } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { TypeApplyResult, TypeClassifyResult } from "../../src/optimize/typeController";
import type { TypeProposal, TypeScanReport } from "../../src/optimize/typeScan";
import { TypeWeaveModal } from "../../src/view/TypeWeaveModal";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const proposal = (path: string, type: string, over: Partial<TypeProposal> = {}): TypeProposal => ({
  path,
  type,
  evidence: [{ kind: "folder", text: "folder: 3 of 3 typed notes in P/ are project" }],
  checked: true,
  issues: [],
  check: (t) => (t === "person" ? ["'url' is not declared on type 'person'"] : []),
  mtime: 1,
  ...over,
});

const proposals = [proposal("a.md", "project"), proposal("b.md", "project", { checked: false, issues: ["missing required property 'status'"] })];
const base = (list: TypeProposal[] = proposals): TypeScanReport => ({ status: "ok", proposable: ["person", "project"], candidates: list.length + 2, proposals: list, notShown: 0, noProposal: 2, pending: [] });
const result: TypeApplyResult = { typed: 1, skipped: [], failed: [], runNote: null };

const allText = (el: FakeElement): string => [el.textContent, ...el.children.map(allText)].join("\n");
const button = (root: FakeElement, text: string): FakeElement => root.querySelectorAll("button").find((b) => b.textContent === text)!;
const disabled = (el: FakeElement): boolean => (el as unknown as { disabled: boolean }).disabled;
const checks = (root: FakeElement) => root.querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;
const selects = (root: FakeElement) => root.querySelectorAll("select");

const setup = (report = base()) => {
  const actions = {
    apply: vi.fn(async (_rows: Array<{ path: string; type: string }>) => result),
    dismiss: vi.fn(async (_path: string) => undefined),
    classify: vi.fn(async (_signal: AbortSignal): Promise<TypeClassifyResult> => ({ judged: 0, typed: 0, none: 0, failedBatches: 0, notChecked: 0 })),
    rescan: vi.fn(async (): Promise<TypeScanReport> => report),
    classifierInfo: vi.fn(async (): Promise<{ label: string; model: string } | { needsConfirmation: true }> => ({ label: "Ollama", model: "qwen3:1.7b" })),
  };
  const onDone = vi.fn();
  const modal = new TypeWeaveModal(new App(), report, actions, onDone);
  modal.onOpen();
  return { modal, actions, onDone, root: () => modal.contentEl as unknown as FakeElement };
};

describe("TypeWeaveModal", () => {
  it("lists rows with evidence and the conformance line; only the conforming row starts checked", () => {
    const { modal, root } = setup();
    expect(modal.titleEl.textContent).toBe("Review 2 note types");
    expect(allText(root())).toContain("folder: 3 of 3 typed notes in P/ are project");
    expect(allText(root())).toContain("adds 1 issue: missing required property 'status'");
    expect(checks(root()).map((c) => c.checked)).toEqual([true, false]);
    expect(selects(root()).map((s) => s.value)).toEqual(["project", "project"]);
  });

  it("offers exactly the proposable types in each dropdown", () => {
    const { root } = setup();
    expect(selects(root())[0]!.children.map((o) => o.textContent)).toEqual(["person", "project"]);
  });

  it("each dropdown's options equal report.proposable exactly", () => {
    const report = { ...base(), proposable: ["concept", "meeting", "person", "project"] };
    const { root } = setup(report);
    for (const select of selects(root())) expect(select.children.map((o) => o.textContent)).toEqual(report.proposable);
  });

  it("a dropdown change sets the row's type and Apply receives exactly that type", async () => {
    const { root, actions } = setup(base([proposal("a.md", "project")]));
    selects(root())[0]!.value = "person";
    selects(root())[0]!.dispatchEvent({ type: "change" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).toHaveBeenCalledWith([{ path: "a.md", type: "person" }]);
  });

  it("states how many untyped notes have no proposal and how many rows were not shown", () => {
    const { root } = setup({ ...base(), notShown: 7 });
    expect(allText(root())).toContain("7 more rows not shown. Apply, then run this again.");
    expect(allText(root())).toContain("2 untyped notes have no proposal.");
  });

  it("applies only the checked rows with their current type, once", async () => {
    const { root, actions, onDone } = setup();
    checks(root())[1]!.checked = true;
    checks(root())[1]!.dispatchEvent({ type: "change" });
    selects(root())[0]!.value = "person";
    selects(root())[0]!.dispatchEvent({ type: "change" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).toHaveBeenCalledTimes(1);
    expect(actions.apply).toHaveBeenCalledWith([{ path: "a.md", type: "person" }, { path: "b.md", type: "project" }]);
    expect(onDone).toHaveBeenCalledWith(result);
  });

  it("applies nothing for an unchecked row", async () => {
    const { root, actions } = setup();
    checks(root())[0]!.checked = false;
    checks(root())[0]!.dispatchEvent({ type: "change" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).toHaveBeenCalledWith([]);
  });

  it("changing the dropdown recomputes the conformance line and keeps the checked state", () => {
    const { root } = setup();
    selects(root())[0]!.value = "person";
    selects(root())[0]!.dispatchEvent({ type: "change" });
    expect(allText(root())).toContain("adds 1 issue: 'url' is not declared on type 'person'");
    expect(checks(root())[0]!.checked).toBe(true);
    selects(root())[0]!.value = "project";
    selects(root())[0]!.dispatchEvent({ type: "change" });
    expect(allText(root())).not.toContain("'url' is not declared");
  });

  it("dropdown ignores a type outside the list", () => {
    const { root } = setup();
    selects(root())[0]!.value = "entity";
    selects(root())[0]!.dispatchEvent({ type: "change" });
    expect(allText(root())).not.toContain("entity");
  });

  it("dismiss persists the path, removes the row, and applies nothing", async () => {
    const { modal, root, actions } = setup();
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.dismiss).toHaveBeenCalledWith("a.md");
    expect(actions.apply).not.toHaveBeenCalled();
    expect(modal.titleEl.textContent).toBe("Review 1 note type");
  });

  it("a dismiss rejection shows a notice and keeps the row", async () => {
    const { modal, root, actions } = setup();
    actions.dismiss.mockRejectedValueOnce(new Error("nope"));
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(modal.titleEl.textContent).toBe("Review 2 note types");
    expect(getNoticeMessages()).toContain("Type dismiss failed: nope");
  });

  it("dismiss is ignored and disabled while Apply runs", async () => {
    const { root, actions } = setup();
    actions.apply.mockImplementationOnce(() => new Promise<TypeApplyResult>(() => {}));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    expect(disabled(button(root(), "Dismiss"))).toBe(true);
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.dismiss).not.toHaveBeenCalled();
  });

  it("cancel and plain close write nothing and report null once", async () => {
    const a = setup();
    button(a.root(), "Cancel").dispatchEvent({ type: "click" });
    await settle();
    expect(a.actions.apply).not.toHaveBeenCalled();
    expect(a.onDone).toHaveBeenCalledTimes(1);
    expect(a.onDone).toHaveBeenCalledWith(null);
    const b = setup();
    b.modal.onClose();
    expect(b.onDone).toHaveBeenCalledWith(null);
  });

  it("an apply rejection shows a notice and reports null once", async () => {
    const { root, actions, onDone } = setup();
    actions.apply.mockRejectedValueOnce(new Error("boom"));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
    expect(getNoticeMessages()).toContain("Type weave failed: boom");
  });

  it("closing while apply is in flight reports the result once, after it settles", async () => {
    const { root, actions, onDone, modal } = setup();
    let release!: (r: TypeApplyResult) => void;
    actions.apply.mockImplementationOnce(() => new Promise<TypeApplyResult>((resolve) => { release = resolve; }));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Cancel").dispatchEvent({ type: "click" });
    modal.onClose();
    expect(onDone).not.toHaveBeenCalled();
    release(result);
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(result);
  });

  it("shows the empty state", () => {
    expect(allText(setup(base([])).root())).toContain("No type proposals to review.");
  });

  it("discloses what is sent and to whom, and does not call the model on open", async () => {
    const { root, actions } = setup();
    await settle();
    expect(allText(root())).toContain("Sends each note's title, folder, tags, up to 5 headings, and its first 200 characters to Ollama (qwen3:1.7b).");
    expect(disabled(button(root(), "Check with model"))).toBe(false);
    expect(actions.classify).not.toHaveBeenCalled();
  });

  it("states the confirmation disclosure and keeps the button enabled when the utility needs confirmation", async () => {
    const b = setup();
    const c = new TypeWeaveModal(new App(), base(), { ...b.actions, classifierInfo: async () => ({ needsConfirmation: true as const }) }, vi.fn());
    c.onOpen();
    await settle();
    const el = c.contentEl as unknown as FakeElement;
    expect(allText(el)).toContain("to your utility model. You will be asked before Claude is used instead.");
    expect(disabled(button(el, "Check with model"))).toBe(false);
  });

  it("shows the classifier error and disables the button when it is unavailable", async () => {
    const b = setup();
    const c = new TypeWeaveModal(new App(), base(), { ...b.actions, classifierInfo: async () => { throw new Error("endpoint is unavailable"); } }, vi.fn());
    c.onOpen();
    await settle();
    const el = c.contentEl as unknown as FakeElement;
    expect(allText(el)).toContain("endpoint is unavailable");
    expect(disabled(button(el, "Check with model"))).toBe(true);
  });

  it("runs one check at a time, rescans, shows the new rows, and posts the notice", async () => {
    const { root, actions, modal } = setup();
    await settle();
    let release!: (r: TypeClassifyResult) => void;
    actions.classify.mockImplementationOnce(() => new Promise<TypeClassifyResult>((resolve) => { release = resolve; }));
    actions.rescan.mockResolvedValueOnce(base([...proposals, proposal("c.md", "person", { evidence: [{ kind: "model", model: "m1" }] })]));
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    expect(disabled(button(root(), "Check with model"))).toBe(true);
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    release({ judged: 1, typed: 1, none: 0, failedBatches: 0, notChecked: 0 });
    await settle();
    expect(actions.classify).toHaveBeenCalledTimes(1);
    expect(modal.titleEl.textContent).toBe("Review 3 note types");
    expect(allText(root())).toContain("model: m1");
    expect(getNoticeMessages()).toContain("Model checked 1 note: 1 typed, 0 no fitting type");
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it("a rescan keeps manual checks on rows the user already saw", async () => {
    const { root, actions } = setup();
    await settle();
    checks(root())[1]!.checked = true;
    checks(root())[1]!.dispatchEvent({ type: "change" });
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.rescan).toHaveBeenCalled();
    expect(checks(root()).map((c) => c.checked)).toEqual([true, true]);
  });

  it("a classify rejection shows the failure notice and re-enables the button", async () => {
    const { root, actions } = setup();
    await settle();
    actions.classify.mockRejectedValueOnce(new Error("boom"));
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    await settle();
    expect(getNoticeMessages()).toContain("Type check failed: boom");
    expect(disabled(button(root(), "Check with model"))).toBe(false);
  });

  it("ignores Apply while a check is running", async () => {
    const { root, actions } = setup();
    await settle();
    actions.classify.mockImplementationOnce(() => new Promise<TypeClassifyResult>(() => {}));
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).not.toHaveBeenCalled();
    expect(disabled(button(root(), "Apply selected"))).toBe(true);
  });

  it("ignores Check with model while Apply is running", async () => {
    const { root, actions } = setup();
    await settle();
    actions.apply.mockImplementationOnce(() => new Promise<TypeApplyResult>(() => {}));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.classify).not.toHaveBeenCalled();
  });

  it("closing during a check aborts its signal and the late resolution posts no notice or rescan", async () => {
    const { root, actions, modal } = setup();
    await settle();
    let signal!: AbortSignal;
    let release!: (r: TypeClassifyResult) => void;
    actions.classify.mockImplementationOnce((s: AbortSignal) => {
      signal = s;
      return new Promise<TypeClassifyResult>((resolve) => { release = resolve; });
    });
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    const before = getNoticeMessages().length;
    modal.onClose();
    expect(signal.aborted).toBe(true);
    release({ judged: 1, typed: 1, none: 0, failedBatches: 0, notChecked: 0 });
    await settle();
    expect(getNoticeMessages()).toHaveLength(before);
    expect(actions.rescan).not.toHaveBeenCalled();
  });
});
