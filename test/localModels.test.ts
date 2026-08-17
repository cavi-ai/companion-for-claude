import { describe, it, expect } from "vitest";
import { mergeDetectedModels } from "../src/providers/localModels";

describe("mergeDetectedModels", () => {
  it("returns the detected list unchanged when it already holds the configured model", () => {
    expect(mergeDetectedModels(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("puts a configured model the server did not report first, so it stays selectable", () => {
    expect(mergeDetectedModels(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("falls back to the configured model alone when nothing was detected", () => {
    expect(mergeDetectedModels([], "c")).toEqual(["c"]);
  });

  it("ignores an empty or whitespace configured model", () => {
    expect(mergeDetectedModels(["a"], "")).toEqual(["a"]);
    expect(mergeDetectedModels(["a"], "   ")).toEqual(["a"]);
    expect(mergeDetectedModels([], "")).toEqual([]);
  });

  it("trims the configured model and dedupes against a padded detected entry", () => {
    expect(mergeDetectedModels(["a"], " a ")).toEqual(["a"]);
  });

  it("drops blank and duplicate detected entries", () => {
    expect(mergeDetectedModels(["a", "", "a", "b"], "")).toEqual(["a", "b"]);
  });
});
