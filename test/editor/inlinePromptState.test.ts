import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HISTORY_CAP,
  RUNNING_LABEL,
  choosePreset,
  initialPrompt,
  placeholderFor,
  pressKey,
  promptKey,
  remember,
  typed,
  type PromptState,
} from "../../src/editor/inlinePromptState";

const PRESETS = ["Improve it.", "Fix grammar.", "Shorten it."];
const ctx = (history: string[] = []) => ({ history, presets: PRESETS });
const editing = (input = "", over: Partial<PromptState> = {}): PromptState => ({ ...initialPrompt("rewrite"), input, ...over });

describe("inlinePromptState module", () => {
  it("imports nothing from obsidian or CodeMirror", () => {
    const source = readFileSync(new URL("../../src/editor/inlinePromptState.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'](obsidian|@codemirror\/[^"']+)["']/);
    expect(source).not.toMatch(/\bimport\b/);
  });
});

describe("mode text", () => {
  it("names the mode in the placeholder and the running label names the stop key", () => {
    expect(placeholderFor("rewrite")).toBe("Rewrite selection…");
    expect(placeholderFor("insert")).toBe("Write at cursor…");
    expect(RUNNING_LABEL).toBe("Working… Esc to stop");
  });
});

describe("promptKey", () => {
  it("ignores keys that belong to an IME composition", () => {
    expect(promptKey({ key: "Enter", isComposing: true })).toBeNull();
    expect(promptKey({ key: "Escape", isComposing: true })).toBeNull();
    expect(promptKey({ key: "Enter", keyCode: 229 })).toBeNull();
  });

  it("claims Enter, Escape, arrows, and Tab so the editor never sees them", () => {
    expect(promptKey({ key: "Enter", shiftKey: false })).toBe("Enter");
    expect(promptKey({ key: "Escape", shiftKey: false })).toBe("Escape");
    expect(promptKey({ key: "ArrowUp", shiftKey: false })).toBe("ArrowUp");
    expect(promptKey({ key: "ArrowDown", shiftKey: false })).toBe("ArrowDown");
    expect(promptKey({ key: "Tab", shiftKey: false })).toBe("Tab");
    expect(promptKey({ key: "Tab", shiftKey: true })).toBe("Shift-Tab");
  });

  it("leaves ordinary typing to the input", () => {
    expect(promptKey({ key: "a", shiftKey: false })).toBeNull();
    expect(promptKey({ key: "Backspace", shiftKey: false })).toBeNull();
  });
});

describe("history", () => {
  it("keeps the most recent instruction first without duplicates", () => {
    let h: string[] = [];
    h = remember(h, "one");
    h = remember(h, "two");
    h = remember(h, " one ");
    expect(h).toEqual(["one", "two"]);
  });

  it("caps at the last 20 instructions", () => {
    let h: string[] = [];
    for (let i = 0; i < 25; i++) h = remember(h, `i${i}`);
    expect(HISTORY_CAP).toBe(20);
    expect(h).toHaveLength(20);
    expect(h[0]).toBe("i24");
    expect(h[19]).toBe("i5");
  });

  it("ignores a blank instruction", () => {
    expect(remember(["a"], "  ")).toEqual(["a"]);
  });
});

describe("Enter", () => {
  it("submits a trimmed non-empty instruction and switches to running", () => {
    const { state, effect } = pressKey(editing("  tighten this "), "Enter", ctx());
    expect(effect).toEqual({ kind: "submit", instruction: "tighten this" });
    expect(state.phase).toBe("running");
  });

  it("does nothing on an empty or blank input", () => {
    expect(pressKey(editing(""), "Enter", ctx()).effect).toEqual({ kind: "none" });
    expect(pressKey(editing("   "), "Enter", ctx())).toEqual({ state: editing("   "), effect: { kind: "none" } });
  });
});

describe("Escape", () => {
  it("closes an editing prompt without running anything", () => {
    expect(pressKey(editing("draft"), "Escape", ctx()).effect).toEqual({ kind: "close" });
  });

  it("aborts a running prompt", () => {
    expect(pressKey(editing("x", { phase: "running" }), "Escape", ctx()).effect).toEqual({ kind: "abort" });
  });

  it("every other key is inert while running", () => {
    const running = editing("x", { phase: "running" });
    for (const key of ["Enter", "ArrowUp", "ArrowDown", "Tab", "Shift-Tab"] as const) {
      expect(pressKey(running, key, ctx(["old"]))).toEqual({ state: running, effect: { kind: "none" } });
    }
    expect(typed(running, "changed")).toBe(running);
  });
});

describe("ArrowUp / ArrowDown recall", () => {
  const history = ["newest", "middle", "oldest"];

  it("ArrowUp in an empty input recalls most recent first, then older, stopping at the oldest", () => {
    let s = pressKey(editing(""), "ArrowUp", ctx(history)).state;
    expect(s.input).toBe("newest");
    s = pressKey(s, "ArrowUp", ctx(history)).state;
    expect(s.input).toBe("middle");
    s = pressKey(s, "ArrowUp", ctx(history)).state;
    s = pressKey(s, "ArrowUp", ctx(history)).state;
    expect(s.input).toBe("oldest");
  });

  it("ArrowUp does not replace text the user typed", () => {
    expect(pressKey(editing("my own words"), "ArrowUp", ctx(history)).state.input).toBe("my own words");
    const recalled = pressKey(editing(""), "ArrowUp", ctx(history)).state;
    const edited = typed(recalled, "newest, edited");
    expect(pressKey(edited, "ArrowUp", ctx(history)).state.input).toBe("newest, edited");
  });

  it("ArrowUp with no history does nothing", () => {
    expect(pressKey(editing(""), "ArrowUp", ctx([])).state).toEqual(editing(""));
  });

  it("ArrowDown walks back toward the newest and then clears", () => {
    let s = pressKey(editing(""), "ArrowUp", ctx(history)).state;
    s = pressKey(s, "ArrowUp", ctx(history)).state;
    s = pressKey(s, "ArrowDown", ctx(history)).state;
    expect(s.input).toBe("newest");
    s = pressKey(s, "ArrowDown", ctx(history)).state;
    expect(s).toMatchObject({ input: "", recall: null });
  });
});

describe("Tab and preset chips", () => {
  it("Tab moves from the input through the chips and back to the input", () => {
    let s = editing("");
    const seen: number[] = [];
    for (let i = 0; i < PRESETS.length + 1; i++) {
      s = pressKey(s, "Tab", ctx()).state;
      seen.push(s.focus);
    }
    expect(seen).toEqual([0, 1, 2, -1]);
    expect(pressKey(editing(""), "Shift-Tab", ctx()).state.focus).toBe(2);
  });

  it("Enter on a chip fills the input with its instruction and returns focus to the input without submitting", () => {
    const onChip = editing("draft", { focus: 1 });
    const { state, effect } = pressKey(onChip, "Enter", ctx());
    expect(effect).toEqual({ kind: "none" });
    expect(state).toMatchObject({ input: "Fix grammar.", focus: -1, phase: "editing" });
    expect(pressKey(state, "Enter", ctx()).effect).toEqual({ kind: "submit", instruction: "Fix grammar." });
  });

  it("a clicked chip fills the input the same way", () => {
    expect(choosePreset(editing(""), 2, PRESETS)).toMatchObject({ input: "Shorten it.", focus: -1 });
    expect(choosePreset(editing("keep"), 9, PRESETS).input).toBe("keep");
  });
});
