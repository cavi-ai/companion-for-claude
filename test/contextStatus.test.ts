import { describe, expect, it } from "vitest";
import { abbreviateNoteName, selectionLineLabel, selectionLineLabelFromText } from "../src/view/contextStatus";

describe("abbreviateNoteName", () => {
  it("uses a fallback when no note is open", () => {
    expect(abbreviateNoteName(null)).toBe("No note");
    expect(abbreviateNoteName("")).toBe("No note");
  });

  it("keeps short names and truncates long names", () => {
    expect(abbreviateNoteName("Daily Log", 20)).toBe("Daily Log");
    expect(abbreviateNoteName("Chapter_12-Exception_Handling_and_Recovery", 18)).toBe("Chapter_12-Except…");
  });
});

describe("selectionLineLabel", () => {
  it("formats one-based editor line ranges", () => {
    expect(selectionLineLabel({ line: 0 }, { line: 0 })).toBe("L1");
    expect(selectionLineLabel({ line: 4 }, { line: 8 })).toBe("L5-L9");
    expect(selectionLineLabel({ line: 8 }, { line: 4 })).toBe("L5-L9");
  });

  it("uses a fallback without a selection", () => {
    expect(selectionLineLabel(null, null)).toBe("No selection");
  });
});

describe("selectionLineLabelFromText", () => {
  const note = ["# Title", "First paragraph.", "Second paragraph starts here", "and continues here.", "Final line."].join("\n");

  it("maps visible selected text back to note line numbers", () => {
    expect(selectionLineLabelFromText(note, "Second paragraph starts here\nand continues here.")).toBe("L3-L4");
    expect(selectionLineLabelFromText(note, "Final line.")).toBe("L5");
  });

  it("returns null when selected text is not in the note", () => {
    expect(selectionLineLabelFromText(note, "not present")).toBeNull();
  });
});
