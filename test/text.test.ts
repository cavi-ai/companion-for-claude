import { describe, expect, it } from "vitest";
import { countOccurrences, lowerSameLength, noteName } from "../src/text";
import { errorMessage, isRecord } from "../src/records";
import { fnv1aFingerprint, fnv1aHex } from "../src/hashing";

describe("lowerSameLength", () => {
  it("lowercases and keeps every index aligned with the input", () => {
    expect(lowerSameLength("Hello ÉLAN")).toBe("hello élan");
    const text = "Trip to İstanbul and Paris";
    const lower = lowerSameLength(text);
    expect(lower).toHaveLength(text.length);
    expect(lower.indexOf("paris")).toBe(text.indexOf("Paris"));
    expect(lower.startsWith("trip to İstanbul")).toBe(true);
  });
});

describe("countOccurrences / noteName / isRecord / errorMessage / fnv1aFingerprint", () => {
  it("counts overlapping occurrences and none for an empty needle", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(3);
    expect(countOccurrences("abc", "")).toBe(0);
  });

  it("names a note from its path", () => {
    expect(noteName("Folder/My Note.md")).toBe("My Note");
    expect(noteName("Note.MD")).toBe("Note");
    expect(noteName("Folder/file.pdf")).toBe("file.pdf");
  });

  it("recognizes plain objects and reads any thrown value", () => {
    expect([isRecord({}), isRecord([]), isRecord(null), isRecord("x")]).toEqual([true, false, false, false]);
    expect([errorMessage(new Error("boom")), errorMessage("text"), errorMessage(42)]).toEqual(["boom", "text", "42"]);
  });

  it("prefixes the fnv1a hex", () => {
    expect(fnv1aFingerprint("abc")).toBe(`fnv1a-${fnv1aHex("abc")}`);
  });
});
