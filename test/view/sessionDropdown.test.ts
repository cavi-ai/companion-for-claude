import { App, clearMenus, FakeElement, getLastMenu } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../src/conversations/store";
import { SessionDropdown, type SessionDropdownActions } from "../../src/view/chat/SessionDropdown";

const g = globalThis as Record<string, unknown>;
let body: FakeElement;
let doc: FakeElement & { body?: FakeElement };

function convo(id: string, title: string, extra: Partial<Conversation> = {}): Conversation {
  return { id, title, createdAt: 1, updatedAt: Date.now() - 3 * 86_400_000, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, { role: "assistant", content: "d" }], ...extra };
}

function actionsStub(): SessionDropdownActions {
  return {
    resume: vi.fn(), rename: vi.fn(), fork: vi.fn(), forkFromSummary: vi.fn(), distill: vi.fn(),
    archive: vi.fn(), unarchive: vi.fn(), remove: vi.fn(),
  };
}

function setup(list: Conversation[], opts: { activeId?: string | null; actions?: SessionDropdownActions; promptRename?: (c: string) => Promise<string | null> } = {}) {
  const anchor = new FakeElement("button");
  anchor.rect = { left: 300, right: 340, top: 10, bottom: 34, width: 40, height: 24 };
  const actions = opts.actions ?? actionsStub();
  let current = list;
  const dropdown = new SessionDropdown({
    app: new App() as never,
    anchor: anchor as unknown as HTMLElement,
    conversations: () => current,
    activeId: () => opts.activeId ?? null,
    actions,
    ...(opts.promptRename ? { promptRename: opts.promptRename } : {}),
  });
  dropdown.open();
  const root = body.querySelector(".cc-session-dropdown")!;
  return { dropdown, root, anchor, actions, setList: (next: Conversation[]) => { current = next; dropdown.refresh(); } };
}

const rows = (root: FakeElement) => root.querySelectorAll(".cc-session-row");
const titles = (root: FakeElement) => rows(root).map((r) => r.querySelector(".cc-session-title")!.textContent);
const key = (el: FakeElement, k: string) => el.dispatchEvent({ type: "keydown", key: k, preventDefault: () => undefined, target: el });
const click = (el: FakeElement) => el.dispatchEvent({ type: "click", stopPropagation: () => undefined });

beforeEach(() => {
  body = new FakeElement("body");
  doc = Object.assign(new FakeElement("document"), { body });
  g.activeDocument = doc;
  g.activeWindow = { innerWidth: 1000 };
  clearMenus();
});

afterEach(() => {
  g.activeDocument = {};
  g.activeWindow = globalThis;
});

describe("SessionDropdown", () => {
  it("renders single-line rows with compact meta and a ⋯ button, anchored under the button", () => {
    const { root } = setup([convo("a", "Alpha"), convo("b", "Beta")]);
    expect(titles(root)).toEqual(["Alpha", "Beta"]);
    expect(rows(root)[0]!.querySelector(".cc-session-meta")!.textContent).toBe("3d · 2 msgs");
    const more = rows(root)[0]!.querySelector(".cc-session-more")!;
    expect(more.getAttribute("aria-label")).toBe("Session actions for Alpha");
    expect(root.style.top).toBe("38px");
    expect(root.style.left).toBe("8px");
  });

  it("marks the active conversation", () => {
    const { root } = setup([convo("a", "Alpha"), convo("b", "Beta")], { activeId: "b" });
    expect(rows(root)[1]!.classList.has("is-active")).toBe(true);
    expect(rows(root)[0]!.classList.has("is-active")).toBe(false);
  });

  it("filters by case-insensitive substring and reports no matches", () => {
    const { root } = setup([convo("a", "Alpha plan"), convo("b", "Beta")]);
    const input = root.querySelector(".cc-session-search")!;
    input.value = "PLAN";
    input.dispatchEvent({ type: "input" });
    expect(titles(root)).toEqual(["Alpha plan"]);
    input.value = "zzz";
    input.dispatchEvent({ type: "input" });
    expect(rows(root)).toHaveLength(0);
    expect(root.querySelector(".cc-session-empty")!.textContent).toBe("No matching sessions");
  });

  it("hides archived rows until the footer toggle, which shows the count", () => {
    const { root } = setup([convo("a", "Alpha"), convo("b", "Old", { archivedAt: 5 })]);
    expect(titles(root)).toEqual(["Alpha"]);
    const toggle = root.querySelector(".cc-session-archive-toggle")!;
    expect(toggle.textContent).toBe("Show archived (1)");
    click(toggle);
    expect(titles(root)).toEqual(["Alpha", "Old"]);
    expect(rows(root)[1]!.classList.has("is-archived")).toBe(true);
    expect(rows(root)[1]!.querySelector(".cc-session-archived-icon")).toBeTruthy();
  });

  it("has no footer toggle without archived conversations", () => {
    const { root } = setup([convo("a", "Alpha")]);
    expect(root.querySelector(".cc-session-archive-toggle")).toBeNull();
  });

  it("↓ then ↵ resumes the second row and closes", () => {
    const { root, actions, dropdown } = setup([convo("a", "Alpha"), convo("b", "Beta")]);
    key(root, "ArrowDown");
    key(root, "Enter");
    expect(actions.resume).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(dropdown.isOpen).toBe(false);
  });

  it("↑ wraps to the last row", () => {
    const { root, actions } = setup([convo("a", "Alpha"), convo("b", "Beta")]);
    key(root, "ArrowUp");
    key(root, "Enter");
    expect(actions.resume).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("clicking a row resumes it", () => {
    const { root, actions } = setup([convo("a", "Alpha")]);
    click(rows(root)[0]!);
    expect(actions.resume).toHaveBeenCalledOnce();
  });

  it("Esc closes and returns focus to the anchor", () => {
    const { root, dropdown, anchor } = setup([convo("a", "Alpha")]);
    key(root, "Escape");
    expect(dropdown.isOpen).toBe(false);
    expect(body.querySelector(".cc-session-dropdown")).toBeNull();
    expect(anchor.getAttribute("data-focused")).toBe("true");
  });

  it("an outside mousedown closes it; one inside does not", () => {
    const { root, dropdown } = setup([convo("a", "Alpha")]);
    doc.dispatchEvent({ type: "mousedown", target: root });
    expect(dropdown.isOpen).toBe(true);
    doc.dispatchEvent({ type: "mousedown", target: new FakeElement("div") });
    expect(dropdown.isOpen).toBe(false);
  });
});

describe("SessionDropdown row menu", () => {
  function openMenu(root: FakeElement, index = 0) {
    click(rows(root)[index]!.querySelector(".cc-session-more")!);
    return getLastMenu()!;
  }

  it("lists the full action set, with Distill and Archive for a fresh chat", () => {
    const { root } = setup([convo("a", "Alpha")]);
    expect(openMenu(root).titles()).toEqual(["Rename", "Fork", "Fork from summary", "Distill", "Archive", "Delete"]);
  });

  it("shows Re-distill and Unarchive by state", () => {
    const { root } = setup([convo("a", "Alpha", { distilledNote: "n.md", archivedAt: 5 })]);
    click(root.querySelector(".cc-session-archive-toggle")!);
    expect(openMenu(root).titles()).toEqual(["Rename", "Fork", "Fork from summary", "Re-distill", "Unarchive", "Delete"]);
  });

  it("Archive keeps the dropdown open and re-renders without the row", async () => {
    const actions = actionsStub();
    const { root, dropdown, setList } = setup([convo("a", "Alpha")], { actions });
    vi.mocked(actions.archive).mockImplementation(() => { setList([convo("a", "Alpha", { archivedAt: 9 })]); });
    openMenu(root).item("Archive")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.archive).toHaveBeenCalledOnce();
    expect(dropdown.isOpen).toBe(true);
    expect(rows(root)).toHaveLength(0);
    expect(root.querySelector(".cc-session-archive-toggle")!.textContent).toBe("Show archived (1)");
  });

  it("Fork closes the dropdown and calls fork", () => {
    const { root, actions, dropdown } = setup([convo("a", "Alpha")]);
    openMenu(root).item("Fork")!.click();
    expect(dropdown.isOpen).toBe(false);
    expect(actions.fork).toHaveBeenCalledOnce();
  });

  it("Fork from summary closes the dropdown", () => {
    const { root, actions, dropdown } = setup([convo("a", "Alpha")]);
    openMenu(root).item("Fork from summary")!.click();
    expect(dropdown.isOpen).toBe(false);
    expect(actions.forkFromSummary).toHaveBeenCalledOnce();
  });

  it("Rename trims the prompt reply; empty or unchanged is a no-op", async () => {
    const replies = ["  New name ", "   ", "Alpha"];
    const prompt = vi.fn(async () => replies.shift() ?? null);
    const { root, actions, dropdown } = setup([convo("a", "Alpha")], { promptRename: prompt });
    for (let i = 0; i < 3; i++) {
      openMenu(root).item("Rename")!.click();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(prompt).toHaveBeenCalledWith("Alpha");
    expect(actions.rename).toHaveBeenCalledTimes(1);
    expect(actions.rename).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "New name");
    expect(dropdown.isOpen).toBe(true);
  });

  it("an outside click while the rename prompt is open does not close the dropdown", async () => {
    let resolve!: (v: string | null) => void;
    const prompt = () => new Promise<string | null>((r) => { resolve = r; });
    const { root, dropdown } = setup([convo("a", "Alpha")], { promptRename: prompt });
    openMenu(root).item("Rename")!.click();
    doc.dispatchEvent({ type: "mousedown", target: new FakeElement("div") });
    expect(dropdown.isOpen).toBe(true);
    resolve(null);
  });

  it("Delete needs a second tap within the arm window", async () => {
    vi.useFakeTimers();
    try {
      const { root, actions, dropdown } = setup([convo("a", "Alpha"), convo("b", "Beta")], { activeId: "b" });
      openMenu(root).item("Delete")!.click();
      expect(actions.remove).not.toHaveBeenCalled();
      expect(rows(root)[0]!.classList.has("is-armed")).toBe(true);
      vi.advanceTimersByTime(1);
      const reopened = getLastMenu()!;
      expect(reopened.titles()).toContain("Confirm delete");
      reopened.item("Confirm delete")!.click();
      await Promise.resolve();
      expect(actions.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
      expect(dropdown.isOpen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the arm expires after 2.5s", () => {
    vi.useFakeTimers();
    try {
      const { root, actions } = setup([convo("a", "Alpha")]);
      openMenu(root).item("Delete")!.click();
      vi.advanceTimersByTime(2600);
      expect(rows(root)[0]!.classList.has("is-armed")).toBe(false);
      expect(openMenu(root).titles()).toContain("Delete");
      expect(actions.remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleting the active conversation closes the dropdown", () => {
    vi.useFakeTimers();
    try {
      const { root, actions, dropdown } = setup([convo("a", "Alpha")], { activeId: "a" });
      openMenu(root).item("Delete")!.click();
      vi.advanceTimersByTime(1);
      getLastMenu()!.item("Confirm delete")!.click();
      expect(dropdown.isOpen).toBe(false);
      expect(actions.remove).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
