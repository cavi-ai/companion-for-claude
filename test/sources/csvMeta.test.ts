import { describe, it, expect } from "vitest";
import { parseCsvMeta } from "../../src/sources/csvMeta";

describe("parseCsvMeta", () => {
  it("reads headers and counts data rows", () => {
    expect(parseCsvMeta("date,region,units\n2024,US,10\n2025,EU,20")).toEqual({ columns: ["date", "region", "units"], rows: 2 });
  });
  it("handles quoted fields containing commas", () => {
    expect(parseCsvMeta('name,"city, state"\nx,"Austin, TX"')).toEqual({ columns: ["name", "city, state"], rows: 1 });
  });
  it("ignores trailing blank lines and CRLF", () => {
    expect(parseCsvMeta("a,b\r\n1,2\r\n\r\n")).toEqual({ columns: ["a", "b"], rows: 1 });
  });
  it("returns null for empty / header-less input", () => {
    expect(parseCsvMeta("")).toBeNull();
    expect(parseCsvMeta("\n\n")).toBeNull();
  });
});
