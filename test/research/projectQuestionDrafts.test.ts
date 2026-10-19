import { describe, expect, it } from "vitest";
import { getLastOpenedModal, WorkspaceLeaf, type FakeElement } from "obsidian";
import { ProjectCreateModal } from "../../src/view/research/projectCreateModal";
import type { ProjectCreateInput } from "../../src/view/research/shared";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const root = () => getLastOpenedModal()!.contentEl as unknown as FakeElement;
const field = (label: string) => ["input", "textarea"].flatMap((tag) => root().querySelectorAll(tag)).find((item) => item.getAttribute("aria-label") === label)!;
const button = (text: string) => root().querySelectorAll("button").find((item) => item.textContent === text)!;
const type = (field: FakeElement, value: string) => { field.value = value; field.dispatchEvent({ type: "input" }); };
const click = (field: FakeElement) => field.dispatchEvent({ type: "click" });
function open(rewrite: () => Promise<string>, submit: (input: ProjectCreateInput) => Promise<void> = async () => undefined) {
  const modal = new ProjectCreateModal(new WorkspaceLeaf().app, submit, rewrite, { title: "Notification batching", question: "Does batching help?", folder: "Research/Batching" });
  modal.open();
  return modal;
}

describe("research question drafts", () => {
  it("applies a requested draft when the question is untouched", async () => {
    const request = deferred();
    open(() => request.promise);
    click(button("Draft with Claude"));
    request.resolve("How does batching affect incident response?");
    await settle();
    expect(field("Research question").value).toBe("How does batching affect incident response?");
  });
  it("keeps edits and saves the edited question after dismissing the suggestion", async () => {
    const request = deferred();
    let saved: ProjectCreateInput | undefined;
    open(() => request.promise, async (input) => { saved = input; });
    click(button("Draft with Claude"));
    type(field("Research question"), "How does batching affect senior engineers?");
    request.resolve("How does batching affect incident response?");
    await settle();
    expect(field("Research question").value).toBe("How does batching affect senior engineers?");
    expect(root().querySelector(".cc-research-question-suggestion")?.querySelectorAll("p").map((item) => item.textContent)).toContain("How does batching affect incident response?");
    click(button("Dismiss suggestion"));
    click(button("Create project"));
    await settle();
    expect(saved?.question).toBe("How does batching affect senior engineers?");
  });
  it("uses a suggestion only after an explicit choice", async () => {
    const request = deferred();
    open(() => request.promise);
    click(button("Draft with Claude"));
    type(field("Research question"), "My corrected question?");
    request.resolve("The generated alternative?");
    await settle();
    expect(field("Research question").value).toBe("My corrected question?");
    click(button("Use suggested question"));
    expect(field("Research question").value).toBe("The generated alternative?");
  });
  it("recognizes edits even when the user returns to the original text", async () => {
    const request = deferred();
    open(() => request.promise);
    click(button("Draft with Claude"));
    type(field("Research question"), "A temporary correction?");
    type(field("Research question"), "Does batching help?");
    request.resolve("The generated alternative?");
    await settle();
    expect(field("Research question").value).toBe("Does batching help?");
    expect(button("Use suggested question")).toBeDefined();
  });
  it("ignores an old title response when a newer title is drafting", async () => {
    const old = deferred(), current = deferred();
    let count = 0;
    open(() => ++count === 1 ? old.promise : current.promise);
    const title = field("Project title");
    type(field("Research question"), "");
    title.dispatchEvent({ type: "blur" });
    type(title, "On-call interruptions");
    title.dispatchEvent({ type: "blur" });
    old.resolve("Does notification batching help?");
    await settle();
    expect(field("Research question").value).toBe("");
    current.resolve("How do interruptions affect on-call engineers?");
    await settle();
    expect(field("Research question").value).toBe("How do interruptions affect on-call engineers?");
  });
  it("ignores errors from a closed modal after reopening", async () => {
    const old = deferred(), current = deferred();
    let count = 0;
    const modal = open(() => ++count === 1 ? old.promise : current.promise);
    click(button("Draft with Claude"));
    modal.close();
    modal.open();
    click(button("Draft with Claude"));
    old.reject(new Error("Old request failed"));
    await settle();
    expect(root().querySelector('[role="alert"]')?.textContent).toBe("");
    expect(button("Drafting…").disabled).toBe(true);
    current.resolve("The current question?");
    await settle();
    expect(field("Research question").value).toBe("The current question?");
  });
  it("does not apply a result to fields after closing", async () => {
    const request = deferred();
    const modal = open(() => request.promise);
    const question = field("Research question");
    click(button("Draft with Claude"));
    modal.close();
    request.resolve("A late question?");
    await settle();
    expect(question.value).toBe("Does batching help?");
  });
  it("retains typed text after failure and supports retry", async () => {
    const failed = deferred(), retry = deferred();
    let count = 0;
    open(() => ++count === 1 ? failed.promise : retry.promise);
    click(button("Draft with Claude"));
    type(field("Research question"), "My corrected question?");
    failed.reject(new Error("Connection interrupted"));
    await settle();
    expect(field("Research question").value).toBe("My corrected question?");
    expect(root().querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
    click(button("Draft with Claude"));
    retry.resolve("A useful retry?");
    await settle();
    expect(field("Research question").value).toBe("A useful retry?");
  });
});
