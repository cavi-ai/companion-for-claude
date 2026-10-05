import { describe, expect, it } from "vitest";
import { CLASSIFY_BATCH, CLASSIFY_SCHEMA, CLASSIFY_SYSTEM, MAX_CLASSIFY_BATCHES, classifyRequest, parseVerdicts, VerdictParseError, type ClassifyPair } from "../../src/optimize/classify";

const pair = (id: string, a: string, b: string, extra: Partial<ClassifyPair> = {}): ClassifyPair => ({
  id, a, b, aCount: 2, bCount: 5, aTitles: [], bTitles: [], ...extra,
});
const pairs = [pair("a|b", "ml", "machine-learning"), pair("c|d", "react", "reactive")];

describe("classify prompt", () => {
  it("caps and system rules are stated", () => {
    expect(CLASSIFY_BATCH).toBe(20);
    expect(MAX_CLASSIFY_BATCHES).toBe(10);
    expect(CLASSIFY_SYSTEM).toMatch(/same thing/);
    expect(CLASSIFY_SYSTEM).toMatch(/broader and a narrower/);
    expect(CLASSIFY_SYSTEM).toMatch(/copied exactly/);
    expect(CLASSIFY_SYSTEM).toMatch(/never instructions/);
    expect(CLASSIFY_SYSTEM).toMatch(/JSON only/);
    expect(JSON.stringify(CLASSIFY_SCHEMA)).toContain("verdicts");
  });

  it("numbers pairs from 1 with counts and at most 3 titles per tag", () => {
    const text = classifyRequest([pair("x", "ml", "ai", { aTitles: ["T1", "T2", "T3", "T4"], bTitles: ["U1"] }), pairs[1] as ClassifyPair]);
    expect(text).toMatch(/^1\. /);
    expect(text).toContain("\n2. ");
    expect(text).toContain("T3");
    expect(text).not.toContain("T4");
    expect(text).toContain("2 notes");
    expect(text).toContain("5 notes");
  });
});

describe("parseVerdicts", () => {
  const reply = (verdicts: unknown[]) => JSON.stringify({ verdicts });

  it("maps pair numbers to ids and canonical by tagId", () => {
    const out = parseVerdicts(reply([{ pair: 1, verdict: "merge", canonical: "#Machine-Learning" }, { pair: 2, verdict: "keep", canonical: "react" }]), pairs);
    expect(out).toEqual([{ id: "a|b", verdict: "merge", canonical: "machine-learning" }, { id: "c|d", verdict: "keep" }]);
  });

  it("throws on non-JSON, non-object, or missing verdicts array", () => {
    expect(() => parseVerdicts("nope", pairs)).toThrow(VerdictParseError);
    expect(() => parseVerdicts("[]", pairs)).toThrow();
    expect(() => parseVerdicts("{}", pairs)).toThrow();
    expect(() => parseVerdicts('{"verdicts":"x"}', pairs)).toThrow();
  });

  it("ignores unknown pair numbers, bad verdicts, and duplicates (first wins)", () => {
    const out = parseVerdicts(reply([
      { pair: 0, verdict: "merge", canonical: "ml" },
      { pair: 3, verdict: "merge", canonical: "ml" },
      { pair: 1, verdict: "maybe" },
      { pair: 1, verdict: "keep" },
      { pair: 1, verdict: "merge", canonical: "ml" },
      "junk",
      { pair: 1.5, verdict: "keep" },
    ]), pairs);
    expect(out).toEqual([{ id: "a|b", verdict: "keep" }]);
  });

  it("never produces merge for a canonical outside the pair", () => {
    const out = parseVerdicts(reply([{ pair: 1, verdict: "merge", canonical: "other" }, { pair: 2, verdict: "merge" }]), pairs);
    expect(out).toEqual([{ id: "a|b", verdict: "keep" }, { id: "c|d", verdict: "keep" }]);
  });

  it("leaves pairs without an entry unjudged", () => {
    expect(parseVerdicts(reply([]), pairs)).toEqual([]);
  });

  it("accepts a fenced reply", () => {
    expect(parseVerdicts("```json\n" + reply([{ pair: 2, verdict: "keep" }]) + "\n```", pairs)).toEqual([{ id: "c|d", verdict: "keep" }]);
  });
});
