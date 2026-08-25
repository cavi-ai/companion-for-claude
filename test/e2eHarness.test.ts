import { describe, expect, it } from "vitest";
import { effectiveObsidianCoreVersion } from "../e2e/obsidianHarness";

describe("effectiveObsidianCoreVersion", () => {
  it("uses an explicitly supplied newer auto-update core for an isolated E2E profile", () => {
    expect(effectiveObsidianCoreVersion("1.12.7", "/tmp/obsidian-1.13.7.asar")).toBe("1.13.7");
  });

  it("keeps a newer installed core and rejects ambiguous ASAR names", () => {
    expect(effectiveObsidianCoreVersion("1.14.0", "/tmp/obsidian-1.13.7.asar")).toBe("1.14.0");
    expect(() => effectiveObsidianCoreVersion("1.12.7", "/tmp/core.asar")).toThrow(/obsidian-<version>\.asar/);
  });
});
