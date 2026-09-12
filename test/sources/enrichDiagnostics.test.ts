import { describe, it, expect } from "vitest";
import { EnrichDiagnostics } from "../../src/sources/enrichDiagnostics";

function make(enabled: boolean, append = async (_p: string, _t: string): Promise<void> => {}) {
  const lines: string[] = [];
  const diag = new EnrichDiagnostics(
    { append: async (p, t) => { lines.push(`${p}|${t}`); await append(p, t); }, now: () => 1_700_000_000_000, isMobile: true, path: "Claude/enrichment-diagnostics.log" },
    () => enabled,
  );
  return { diag, lines };
}

describe("EnrichDiagnostics", () => {
  it("appends one line per phase with fields", async () => {
    const { diag, lines } = make(true);
    diag.log("item-start", { path: "Clippings/a.md", bytes: 1234 });
    await Promise.resolve();
    expect(lines).toEqual(["Claude/enrichment-diagnostics.log|2023-11-14T22:13:20.000Z mobile item-start path=Clippings/a.md bytes=1234\n"]);
  });
  it("is a no-op when disabled", async () => {
    const { diag, lines } = make(false);
    diag.log("batch-start", { n: 3 });
    await Promise.resolve();
    expect(lines).toEqual([]);
  });
  it("swallows append failures", async () => {
    const { diag } = make(true, async () => { throw new Error("disk"); });
    expect(() => diag.log("save-done")).not.toThrow();
    await Promise.resolve();
  });
});
