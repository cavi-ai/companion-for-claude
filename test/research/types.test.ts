import { describe, expect, it } from "vitest";
import { isReviewState, RESEARCH_TYPE_NAMES } from "../../src/research/types";
import type { EvidenceRecord, SourceLocatorKind } from "../../src/research/types";
import { SEED_TYPES } from "../../src/ontology/seed";

describe("research vocabulary", () => {
  it("accepts only persisted review states", () => {
    expect(["proposed", "reviewed", "rejected"].every(isReviewState)).toBe(true);
    expect(isReviewState("accepted")).toBe(false);
  });

  it("ships every research ontology type", () => {
    const names = new Set(SEED_TYPES.map((type) => type.name));
    for (const name of RESEARCH_TYPE_NAMES) expect(names.has(name)).toBe(true);
  });

  it("persists evidence locators as ontology-native scalar fields", () => {
    const locatorKind: SourceLocatorKind = "page";
    const evidence: EvidenceRecord = {
      path: "Evidence/E1.md",
      title: "E1",
      type: "evidence",
      project: "[[Research]]",
      source: "[[Source]]",
      excerpt: "Quoted evidence",
      reviewState: "proposed",
      locatorKind,
      locatorValue: "12",
    };
    expect([evidence.locatorKind, evidence.locatorValue]).toEqual(["page", "12"]);

    const schema = SEED_TYPES.find((type) => type.name === "evidence");
    expect(schema?.properties.map((property) => property.key)).toEqual(expect.arrayContaining(["locator_kind", "locator_value"]));
    expect(schema?.properties.map((property) => property.key)).not.toContain("locator");
  });
});
