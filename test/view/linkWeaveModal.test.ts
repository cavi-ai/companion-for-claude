import { App, FakeElement, getNoticeMessages } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { LinkApplyResult } from "../../src/optimize/linkController";
import type { LinkProposal, OrphanReview } from "../../src/optimize/linkScan";
import { LinkWeaveModal } from "../../src/view/LinkWeaveModal";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const mention = { path: "o.md", name: "Café", target: "Café", viaAlias: false, surface: "Café", start: 0, end: 4, line: 1, excerpt: "Café is nice" };
const p = (kind: LinkProposal["kind"], source: string, target: string, checked: boolean, extra: Partial<LinkProposal> = {}): LinkProposal => ({
  id: `${kind}\u0000${source}\u0000${target}`, kind, orphan: kind === "inbound" ? target : source, source, target, linktext: target, checked, ...extra,
});
const groups: OrphanReview[] = [
  { path: "o.md", proposals: [p("outbound", "o.md", "Café.md", true, { mention }), p("related", "o.md", "b.md", false, { score: 0.82 })] },
  { path: "q.md", proposals: [p("inbound", "n.md", "q.md", true, { mention })] },
];
const result: LinkApplyResult = { links: 2, notes: 2, conflicts: [], failed: [], runNote: null };

const allText = (el: FakeElement): string => [el.textContent, ...el.children.map(allText)].join("\n");
const button = (root: FakeElement, text: string): FakeElement => root.querySelectorAll("button").find((b) => b.textContent === text)!;
const checks = (root: FakeElement) => root.querySelectorAll("input") as unknown as Array<FakeElement & { checked: boolean }>;

const setup = (list = groups, remaining = 0) => {
  const actions = {
    apply: vi.fn(async (_selected: LinkProposal[]) => result),
    dismiss: vi.fn(async (_p: LinkProposal) => undefined),
  };
  const onDone = vi.fn();
  const modal = new LinkWeaveModal(new App(), { groups: list, remaining }, actions, onDone);
  modal.onOpen();
  return { modal, actions, onDone, root: () => modal.contentEl as unknown as FakeElement };
};

describe("LinkWeaveModal", () => {
  it("lists a row per proposal with kind label, source to target, excerpt and score; related starts unchecked", () => {
    const { modal, root } = setup();
    expect(modal.titleEl.textContent).toBe("Review 3 link proposals");
    const text = allText(root());
    expect(text).toContain("mentions: o.md → Café.md");
    expect(text).toContain("related 0.82: o.md → b.md");
    expect(text).toContain("mentioned in: n.md → q.md");
    expect(text).toContain("Café is nice");
    expect(checks(root()).map((c) => c.checked)).toEqual([true, false, true]);
  });

  it("applies only the checked rows, once, and reports the result", async () => {
    const { root, actions, onDone } = setup();
    checks(root())[1]!.checked = true;
    checks(root())[1]!.dispatchEvent({ type: "change" });
    checks(root())[2]!.checked = false;
    checks(root())[2]!.dispatchEvent({ type: "change" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.apply).toHaveBeenCalledTimes(1);
    expect(actions.apply.mock.calls[0]![0].map((x) => x.target)).toEqual(["Café.md", "b.md"]);
    expect(onDone).toHaveBeenCalledWith(result);
  });

  it("dismiss persists first, then removes the row and applies nothing", async () => {
    const { modal, root, actions } = setup();
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(actions.dismiss).toHaveBeenCalledWith(groups[0]!.proposals[0]);
    expect(actions.apply).not.toHaveBeenCalled();
    expect(modal.titleEl.textContent).toBe("Review 2 link proposals");
  });

  it("a dismiss rejection shows a notice and keeps the row", async () => {
    const { modal, root, actions } = setup();
    actions.dismiss.mockRejectedValueOnce(new Error("nope"));
    button(root(), "Dismiss").dispatchEvent({ type: "click" });
    await settle();
    expect(modal.titleEl.textContent).toBe("Review 3 link proposals");
    expect(getNoticeMessages()).toContain("Link dismiss failed: nope");
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
    expect(b.actions.apply).not.toHaveBeenCalled();
  });

  it("an apply rejection shows a notice and reports null once", async () => {
    const { root, actions, onDone } = setup();
    actions.apply.mockRejectedValueOnce(new Error("boom"));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
    expect(getNoticeMessages()).toContain("Link weave failed: boom");
  });

  it("closing while apply is in flight reports the result once, after it settles", async () => {
    const { root, actions, onDone, modal } = setup();
    let release!: (r: LinkApplyResult) => void;
    actions.apply.mockImplementationOnce(() => new Promise<LinkApplyResult>((resolve) => { release = resolve; }));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    button(root(), "Cancel").dispatchEvent({ type: "click" });
    modal.onClose();
    expect(onDone).not.toHaveBeenCalled();
    release(result);
    await settle();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(result);
  });

  it("disables Dismiss while apply runs and a click then does nothing", async () => {
    const { root, actions } = setup();
    let release!: (r: LinkApplyResult) => void;
    actions.apply.mockImplementationOnce(() => new Promise<LinkApplyResult>((resolve) => { release = resolve; }));
    button(root(), "Apply selected").dispatchEvent({ type: "click" });
    const dismiss = root().querySelectorAll("button").filter((b) => b.textContent === "Dismiss");
    expect(dismiss.length).toBeGreaterThan(0);
    expect(dismiss.every((b) => (b as unknown as { disabled: boolean }).disabled)).toBe(true);
    for (const b of dismiss) b.dispatchEvent({ type: "click" });
    await settle();
    expect(actions.dismiss).not.toHaveBeenCalled();
    release(result);
    await settle();
  });

  it("states how many more orphans remain and shows the empty state", () => {
    expect(allText(setup(groups, 3).root())).toContain("3 more orphan notes not shown. Apply, then run this again.");
    expect(allText(setup(groups, 1).root())).toContain("1 more orphan note not shown.");
    expect(allText(setup([]).root())).toContain("No orphan notes to connect.");
  });
});
