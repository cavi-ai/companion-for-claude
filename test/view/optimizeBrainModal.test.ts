import { App, FakeElement, getNoticeMessages } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { ApplyResult, ClassifyResult } from "../../src/optimize/controller";
import type { MergeCandidate } from "../../src/optimize/tagScan";
import { OptimizeBrainModal } from "../../src/view/OptimizeBrainModal";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const candidates: MergeCandidate[] = [
  { id: "llm|llms", from: "llms", to: "llm", evidence: ["plural"], score: 1, fromCount: 2, toCount: 9 },
  { id: "kube|kubes", from: "kubes", to: "kube", evidence: ["typo"], score: 0.6, fromCount: 1, toCount: 4 },
];
const result: ApplyResult = { merges: 1, notes: 2, inlineSkipped: 0, failed: [], unchanged: 0, dropped: [], orders: [], runNote: null };

const allText = (el: FakeElement): string => [el.textContent, ...el.children.map(allText)].join("\n");
const button = (root: FakeElement, text: string): FakeElement => root.querySelectorAll("button").find((b) => b.textContent === text)!;
const setup = (list = candidates) => {
  const actions = {
    apply: vi.fn(async () => result),
    dismiss: vi.fn(async () => undefined),
    classify: vi.fn(async (_signal: AbortSignal): Promise<ClassifyResult> => ({ judged: 0, merge: 0, keep: 0, failedBatches: 0, dropped: 0 })),
    rescan: vi.fn(async (): Promise<MergeCandidate[]> => list),
    classifierInfo: vi.fn(async (): Promise<{ label: string; model: string } | { needsConfirmation: true }> => ({ label: "Ollama", model: "qwen3:1.7b" })),
  };
  const onDone = vi.fn();
  const modal = new OptimizeBrainModal(new App(), list, actions, onDone);
  modal.onOpen();
  return { modal, actions, onDone, root: () => modal.contentEl as unknown as FakeElement };
};

describe("OptimizeBrainModal", () => {
  it("lists rows with counts and evidence, plural checked and typo unchecked", () => {
    const { modal, root } = setup();
    expect(modal.titleEl.textContent).toBe("Review 2 tag merges");
    expect(allText(root())).toContain("llms (2) → llm (9)");
    const checks = root().querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;
    expect(checks.map((c) => c.checked)).toEqual([true, false]);
  });

  it("applies only the checked merges, once, then reports the result", async () => {
    const { root, actions, onDone } = setup();
    const checks = root().querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;
    checks[1]!.checked = true;
    checks[1]!.dispatchEvent({ type: "change" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).toHaveBeenCalledTimes(1);
    expect(actions.apply).toHaveBeenCalledWith([{ from: "llms", to: "llm" }, { from: "kubes", to: "kube" }]);
    expect(onDone).toHaveBeenCalledWith(result);
  });

  it("swap flips the direction that gets applied", async () => {
    const { root, actions } = setup();
    button(root(), "Swap").dispatchEvent({ type: "click" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).toHaveBeenCalledWith([{ from: "llm", to: "llms" }]);
  });

  it("dismiss persists through the controller, removes the row, and applies nothing", async () => {
    const { modal, root, actions } = setup();
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.dismiss).toHaveBeenCalledWith("llm|llms");
    expect(actions.apply).not.toHaveBeenCalled();
    expect(modal.titleEl.textContent).toBe("Review 1 tag merge");
    expect(allText(root())).not.toContain("llms (2)");
  });

  it("cancel and plain close write nothing and report null", async () => {
    const a = setup();
    button(a.root(), "Cancel").dispatchEvent({ type: "click" });
    await settle();
    expect(a.actions.apply).not.toHaveBeenCalled();
    expect(a.onDone).toHaveBeenCalledTimes(1);
    expect(a.onDone).toHaveBeenCalledWith(null);
    const b = setup();
    b.modal.onClose();
    expect(b.onDone).toHaveBeenCalledWith(null);
    expect(b.actions.apply).not.toHaveBeenCalled();
  });

  it("titles one row singular and two rows plural", () => {
    expect(setup(candidates.slice(0, 1)).modal.titleEl.textContent).toBe("Review 1 tag merge");
    expect(setup().modal.titleEl.textContent).toBe("Review 2 tag merges");
    expect(setup([]).modal.titleEl.textContent).toBe("Review 0 tag merges");
  });

  it("renders the saved-search description line", () => {
    const { root } = setup();
    expect(allText(root())).toContain("Merges rewrite tags in notes. Saved searches, Bases, and queries that name a merged tag are not changed.");
  });

  it("an apply rejection shows a notice and reports null once", async () => {
    const { root, actions, onDone } = setup();
    actions.apply.mockRejectedValueOnce(new Error("boom"));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
    expect(getNoticeMessages()).toContain("Tag merge failed: boom");
  });

  it("closing while apply is in flight reports the result once, after it settles", async () => {
    const { root, actions, onDone, modal } = setup();
    let release!: (r: ApplyResult) => void;
    actions.apply.mockImplementationOnce(() => new Promise<ApplyResult>((resolve) => { release = resolve; }));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Cancel").dispatchEvent({ type: "click" });
    modal.onClose();
    expect(onDone).not.toHaveBeenCalled();
    release(result);
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(result);
  });

  it("a dismiss rejection shows a notice and keeps the row", async () => {
    const { root, actions, modal } = setup();
    actions.dismiss.mockRejectedValueOnce(new Error("nope"));
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(modal.titleEl.textContent).toBe("Review 2 tag merges");
    expect(getNoticeMessages()).toContain("Tag dismiss failed: nope");
  });

  it("shows the empty state", () => {
    const { root } = setup([]);
    expect(allText(root())).toContain("No tag merges to review.");
  });

  const rows = (root: FakeElement) => root.querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;
  const verdict = (v: "merge" | "keep", canonical?: string) => ({ verdict: v, ...(canonical ? { canonical } : {}), a: "kubes", b: "kube", model: "m", at: "t" });

  it("discloses what is sent and to whom before the button is pressed", async () => {
    const { root, actions } = setup();
    await settle();
    expect(allText(root())).toContain("Sends tag names and up to 3 note titles per tag to Ollama (qwen3:1.7b).");
    expect(button(root(), "Check with model")).toBeDefined();
    expect((button(root(), "Check with model") as unknown as { disabled: boolean }).disabled).toBe(false);
    expect(actions.classify).not.toHaveBeenCalled();
  });

  it("shows the classifier error and disables the button when it is unavailable", async () => {
    const b = setup();
    const c = new OptimizeBrainModal(new App(), candidates, { ...b.actions, classifierInfo: async () => { throw new Error("endpoint is unavailable"); } }, vi.fn());
    c.onOpen();
    await settle();
    const el = c.contentEl as unknown as FakeElement;
    expect(allText(el)).toContain("endpoint is unavailable");
    expect((button(el, "Check with model") as unknown as { disabled: boolean }).disabled).toBe(true);
  });

  it("runs one check at a time, rescans, shows verdicts, and posts the notice", async () => {
    const { root, actions, modal } = setup();
    await settle();
    let release!: (r: ClassifyResult) => void;
    actions.classify.mockImplementationOnce(() => new Promise<ClassifyResult>((resolve) => { release = resolve; }));
    actions.rescan.mockResolvedValueOnce([candidates[0]!, { ...candidates[1]!, verdict: verdict("merge", "kube") }]);
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    expect((button(root(), "Check with model") as unknown as { disabled: boolean }).disabled).toBe(true);
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    release({ judged: 1, merge: 1, keep: 0, failedBatches: 1, dropped: 3 });
    await settle();
    expect(actions.classify).toHaveBeenCalledTimes(1);
    expect(rows(root()).map((c) => c.checked)).toEqual([true, true]);
    expect(allText(root())).toContain("typo · model: merge");
    expect(getNoticeMessages()).toContain("Model checked 1 pair: 1 merge, 0 keep, 1 batch failed, 3 not checked (limit)");
    expect(modal.titleEl.textContent).toBe("Review 2 tag merges");
    expect(actions.apply).not.toHaveBeenCalled();
  });

  it("keeps checks for rows with no new verdict and a new keep verdict unchecks the row", async () => {
    const { root, actions } = setup();
    await settle();
    rows(root())[1]!.checked = true;
    rows(root())[1]!.dispatchEvent({ type: "change" });
    actions.rescan.mockResolvedValueOnce([candidates[0]!, { ...candidates[1]!, verdict: verdict("keep") }]);
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    await settle();
    expect(rows(root()).map((c) => c.checked)).toEqual([true, false]);
    expect(allText(root())).toContain("typo · model: keep");
  });

  it("a classify rejection shows the failure notice and re-enables the button", async () => {
    const { root, actions } = setup();
    await settle();
    actions.classify.mockRejectedValueOnce(new Error("boom"));
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    await settle();
    expect(getNoticeMessages()).toContain("Tag check failed: boom");
    expect((button(root(), "Check with model") as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it("ignores Apply while a check is running", async () => {
    const { root, actions } = setup();
    await settle();
    actions.classify.mockImplementationOnce(() => new Promise<ClassifyResult>(() => {}));
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).not.toHaveBeenCalled();
    expect((button(root(), "Apply selected") as unknown as { disabled: boolean }).disabled).toBe(true);
  });

  it("closing during a check aborts its signal and the late resolution posts no notice", async () => {
    const { root, actions, modal } = setup();
    await settle();
    let signal!: AbortSignal;
    let release!: (r: ClassifyResult) => void;
    actions.classify.mockImplementationOnce((s: AbortSignal) => {
      signal = s;
      return new Promise<ClassifyResult>((resolve) => { release = resolve; });
    });
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    const before = getNoticeMessages().length;
    modal.onClose();
    expect(signal.aborted).toBe(true);
    release({ judged: 1, merge: 1, keep: 0, failedBatches: 0, dropped: 0 });
    await settle();
    expect(getNoticeMessages()).toHaveLength(before);
    expect(actions.rescan).not.toHaveBeenCalled();
  });

  it("ignores Check with model while Apply is running", async () => {
    const { root, actions } = setup();
    await settle();
    actions.apply.mockImplementationOnce(() => new Promise<ApplyResult>(() => {}));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Check with model").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.classify).not.toHaveBeenCalled();
  });

  it("states the confirmation disclosure and keeps the button enabled when the utility needs confirmation", async () => {
    const b = setup();
    const c = new OptimizeBrainModal(new App(), candidates, { ...b.actions, classifierInfo: async () => ({ needsConfirmation: true as const }) }, vi.fn());
    c.onOpen();
    await settle();
    const el = c.contentEl as unknown as FakeElement;
    expect(allText(el)).toContain("Sends tag names and up to 3 note titles per tag to your utility model. You will be asked before Claude is used instead.");
    expect((button(el, "Check with model") as unknown as { disabled: boolean }).disabled).toBe(false);
  });
});
