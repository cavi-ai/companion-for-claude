import { FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DraftSubmission, type DraftStart } from "../../src/view/chat/draftSubmission";

function fixture() {
  const input = new FakeElement() as unknown as HTMLTextAreaElement;
  input.value = "  My question\nwith details  ";
  const submission = new DraftSubmission();
  const resize = vi.fn();
  return { input, submission, resize };
}

describe("draft submission", () => {
  it("clears at acceptance while the turn continues and ignores duplicate starts", async () => {
    const { input, submission, resize } = fixture();
    let accept!: DraftStart;
    let finish!: (result: boolean) => void;
    const first = submission.run(input, () => true, resize, (start) => {
      accept = start;
      return new Promise((resolve) => { finish = resolve; });
    });
    const duplicate = vi.fn();
    expect(submission.pending).toBe(true);
    expect(await submission.run(input, () => true, resize, duplicate)).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
    expect(input.value).toContain("My question");
    accept.accepted();
    expect(input.value).toBe("");
    expect(resize).toHaveBeenCalledOnce();
    expect(submission.pending).toBe(false);

    // A completed older turn must not release a newer startup.
    let finishSecond!: (result: boolean) => void;
    const second = submission.run(input, () => true, resize, () => new Promise((resolve) => { finishSecond = resolve; }));
    finish(true);
    await first;
    expect(submission.pending).toBe(true);
    finishSecond(false);
    await second;
    expect(submission.pending).toBe(false);
  });

  it.each(["edited", "navigated"])("preserves input when %s before acceptance", async (change) => {
    const { input, submission, resize } = fixture();
    const original = input.value;
    let current = true;
    await submission.run(input, () => current, resize, async (start) => {
      if (change === "edited") {
        input.value = "Different question";
        input.dispatchEvent(new Event("input"));
        input.value = original;
      } else {
        current = false;
        input.value = "Another chat's draft";
      }
      start.accepted();
      return true;
    });
    expect(input.value).toBe(change === "edited" ? original : "Another chat's draft");
    expect(resize).not.toHaveBeenCalled();
  });

  it("unlocks after a rejected startup and retains the exact draft", async () => {
    const { input, submission, resize } = fixture();
    const original = input.value;
    await expect(submission.run(input, () => true, resize, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(input.value).toBe(original);
    expect(submission.pending).toBe(false);
    expect(resize).not.toHaveBeenCalled();
  });
});
