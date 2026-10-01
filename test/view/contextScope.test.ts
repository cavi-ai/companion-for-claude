import { describe, expect, it } from "vitest";
import type { ContextToggles } from "../../src/types";
import { applyMention, effectiveToggles, initialToggles } from "../../src/view/chat/contextScope";

const OFF: ContextToggles = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

describe("contextScope", () => {
  it("initialToggles copies the defaults and never aliases them", () => {
    const defaults = { ...OFF, activeNote: true };
    const tab = initialToggles(defaults);
    expect(tab).toEqual(defaults);
    tab.searchVault = true;
    expect(defaults.searchVault).toBe(false);
  });

  it.each([
    ["note", "activeNote"],
    ["selection", "selection"],
    ["linked", "linkedNotes"],
    ["vault", "searchVault"],
  ] as const)("applyMention(%s) turns on %s and returns a new object", (kind, key) => {
    const before = { ...OFF };
    const after = applyMention(before, kind);
    expect(after).toEqual({ ...OFF, [key]: true });
    expect(after).not.toBe(before);
    expect(before).toEqual(OFF);
  });

  it("effectiveToggles lets the turn override win over the tab", () => {
    const tab = { ...OFF, linkedNotes: true };
    expect(effectiveToggles(tab, { activeNote: true }, false)).toEqual({ ...OFF, linkedNotes: true, activeNote: true });
    expect(effectiveToggles(tab, null, false)).toEqual(tab);
  });

  it("agent turn strips searchVault even when the tab has it on", () => {
    const tab = { ...OFF, searchVault: true, activeNote: true };
    expect(effectiveToggles(tab, { searchVault: true }, true)).toEqual({ ...OFF, activeNote: true });
  });
});
