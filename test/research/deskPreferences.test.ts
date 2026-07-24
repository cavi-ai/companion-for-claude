import { describe, expect, it } from "vitest";
import { dismissDeskAction, normalizeDeskPreferenceMap, pinDeskAction } from "../../src/research/deskPreferences";

describe("research Desk preferences", () => {
  it("normalizes malformed persisted data without leaking preferences across projects", () => {
    expect(normalizeDeskPreferenceMap({ "P/Project.md": { dismissedActionIds: ["a", "a", "", 3], pinnedActionId: 4 }, broken: "value" })).toEqual({
      "P/Project.md": { dismissedActionIds: ["a"] },
    });
  });

  it("dismisses and pins actions immutably", () => {
    const initial = { dismissedActionIds: ["a"] };
    expect(dismissDeskAction(initial, "b")).toEqual({ dismissedActionIds: ["a", "b"] });
    expect(pinDeskAction(initial, "a")).toEqual({ dismissedActionIds: [], pinnedActionId: "a" });
    expect(pinDeskAction({ dismissedActionIds: [], pinnedActionId: "a" }, "a")).toEqual({ dismissedActionIds: [] });
    expect(initial).toEqual({ dismissedActionIds: ["a"] });
  });
});
