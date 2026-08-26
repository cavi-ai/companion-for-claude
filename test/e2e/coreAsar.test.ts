import { describe, expect, it } from "vitest";
import { compareVersions, coreAsarVersion, effectiveObsidianCoreVersion, newestCoreAsar } from "../../e2e/coreAsar";

describe("compareVersions", () => {
  it.each([
    ["1.13.0", "1.12.7", 1],
    ["1.12.7", "1.13.0", -1],
    ["1.13.0", "1.13.0", 0],
    ["1.13", "1.13.0", 0],
    ["1.13.10", "1.13.9", 1],
    ["1.9.0", "1.10.0", -1],
  ])("orders %s against %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe("coreAsarVersion", () => {
  it("reads the version out of an official core file name", () => {
    expect(coreAsarVersion("obsidian-1.13.7.asar")).toBe("1.13.7");
  });

  it.each(["obsidian.asar", "obsidian-next.asar", "app.asar", "obsidian-1.13.7.asar.bak"])(
    "rejects %s",
    (name) => { expect(coreAsarVersion(name)).toBeUndefined(); },
  );
});

describe("newestCoreAsar", () => {
  it("picks the highest version, not the last listed", () => {
    expect(newestCoreAsar(["obsidian-1.13.7.asar", "obsidian-1.14.0.asar", "obsidian-1.12.7.asar"])).toBe("obsidian-1.14.0.asar");
  });

  it("compares numerically rather than lexically", () => {
    expect(newestCoreAsar(["obsidian-1.9.0.asar", "obsidian-1.10.0.asar"])).toBe("obsidian-1.10.0.asar");
  });

  it("ignores unrelated files in the directory", () => {
    expect(newestCoreAsar(["obsidian.asar", "logs", "obsidian-1.13.7.asar"])).toBe("obsidian-1.13.7.asar");
  });

  it("finds nothing when no core has been downloaded", () => {
    expect(newestCoreAsar(["obsidian.json", "Cache"])).toBeUndefined();
  });
});

describe("effectiveObsidianCoreVersion", () => {
  it("falls back to the installed shell when no core was downloaded", () => {
    expect(effectiveObsidianCoreVersion("1.12.7")).toBe("1.12.7");
  });

  it("reports the downloaded core the shell will actually load", () => {
    expect(effectiveObsidianCoreVersion("1.12.7", "obsidian-1.13.7.asar")).toBe("1.13.7");
  });

  it("keeps the installed shell when it is newer than the downloaded core", () => {
    expect(effectiveObsidianCoreVersion("1.14.0", "obsidian-1.13.7.asar")).toBe("1.14.0");
  });

  it("refuses a path that is not an official core file", () => {
    expect(() => effectiveObsidianCoreVersion("1.12.7", "custom.asar")).toThrow("obsidian-<version>.asar");
  });
});
