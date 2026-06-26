import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "../src/types";

describe("source-capture defaults", () => {
  it("ships dormant (opt-in) with a default inbox", () => {
    expect(DEFAULT_SETTINGS.sourceCaptureEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.sourceEnrichOnCreate).toBe(true);
    expect(DEFAULT_SETTINGS.sourceInboxFolder).toBe("Clippings");
    expect(DEFAULT_SETTINGS.sourceBaseTags).toEqual(["source"]);
    expect(DEFAULT_SETTINGS.sourceSchemaOverrides).toEqual({});
  });
});

describe("memory settings defaults", () => {
  it("ships sane defaults", () => {
    expect(DEFAULT_SETTINGS.memoryEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.memoryFolder).toBe("Claude/Sessions");
    expect(DEFAULT_SETTINGS.memoryIngestOnSave).toBe(false);
    expect(DEFAULT_SETTINGS.memoryBaseTags).toEqual(["claude", "session"]);
  });
  it("has a plans folder default", () => {
    expect(DEFAULT_SETTINGS.planFolder).toBe("Claude/Plans");
  });
  it("defaults max tokens to 20k for headroom", () => {
    expect(DEFAULT_SETTINGS.maxTokens).toBe(20000);
  });
  it("opens artifacts in Obsidian by default", () => {
    expect(DEFAULT_SETTINGS.artifactOpenTarget).toBe("obsidian");
  });
});
