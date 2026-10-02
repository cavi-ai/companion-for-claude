import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { planEdits } from "../../src/edit/diff";
import { reviewAndApply } from "../../src/edit/reviewAndApply";
import type { ReviewEditsDeps } from "../../src/editor/reviewEdits";

const DOC = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\nη\nθ\nι\nκ\nλ\nμ\n";

function setup(accepted: boolean[] | null) {
  const app = new App();
  const file = app.vault.seed("A.md", DOC);
  const plan = planEdits(DOC, [{ old_str: "alpha", new_str: "ALPHA" }, { old_str: "μ", new_str: "MU" }]);
  const openModal = vi.fn(async () => accepted);
  const deps = { reviewInline: vi.fn(), openModal } as unknown as ReviewEditsDeps;
  return { app, file, plan, deps, openModal };
}

describe("reviewAndApply", () => {
  it("applies every accepted hunk on the modal path", async () => {
    const s = setup([true, true]);
    const result = await reviewAndApply(s.app as never, s.file, s.plan, "swap", { inlineEnabled: false }, s.deps);
    expect(result).toEqual({ applied: 2, total: 2, remaining: [], cancelled: false });
    expect(await s.app.vault.cachedRead(s.file)).toContain("ALPHA");
    expect(await s.app.vault.cachedRead(s.file)).toContain("MU");
  });

  it("returns the rejected hunks as remaining edits", async () => {
    const s = setup([true, false]);
    const result = await reviewAndApply(s.app as never, s.file, s.plan, undefined, { inlineEnabled: false }, s.deps);
    expect(result.applied).toBe(1);
    expect(result.cancelled).toBe(false);
    expect(result.remaining).toEqual([{ old_str: s.plan.hunks[1]!.oldText, new_str: s.plan.hunks[1]!.newText }]);
    const text = await s.app.vault.cachedRead(s.file);
    expect(text).toContain("ALPHA");
    expect(text).not.toContain("MU");
  });

  it("writes nothing and reports cancelled when the review is dismissed", async () => {
    const s = setup(null);
    const result = await reviewAndApply(s.app as never, s.file, s.plan, undefined, { inlineEnabled: false }, s.deps);
    expect(result).toMatchObject({ applied: 0, total: 2, cancelled: true });
    expect(result.remaining).toHaveLength(2);
    expect(await s.app.vault.cachedRead(s.file)).toBe(DOC);
  });

  it("writes nothing when the signal aborted during review", async () => {
    const s = setup([true, true]);
    const controller = new AbortController();
    s.openModal.mockImplementation(async () => { controller.abort(); return [true, true]; });
    const result = await reviewAndApply(s.app as never, s.file, s.plan, undefined, { inlineEnabled: false, signal: controller.signal }, s.deps);
    expect(result.cancelled).toBe(true);
    expect(await s.app.vault.cachedRead(s.file)).toBe(DOC);
  });
});
