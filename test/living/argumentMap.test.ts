import { describe, expect, it } from "vitest";
import { argumentMapPrompt, isQuoted, parseArgumentMap, renderArgumentMap } from "../../src/living/argumentMap";

const ARTICLE = "The moon pulls the oceans and creates **two tides** a day.\n\nSpring tides happen at new and full moon.";

describe("parseArgumentMap", () => {
  it("reads a fenced reply, trims fields, and drops empty claims and items", () => {
    const raw = "```json\n" + JSON.stringify({
      thesis: "  Lunar gravity drives the tides. ",
      claims: [
        { claim: "Two tides a day.", evidence: ["The moon pulls the oceans and creates two tides a day.", " ", 3], objections: [] },
        { claim: "  ", evidence: [], objections: [] },
      ],
      takeaway: "Tides follow the moon.",
    }) + "\n```";
    expect(parseArgumentMap(raw)).toEqual({
      thesis: "Lunar gravity drives the tides.",
      claims: [{ claim: "Two tides a day.", evidence: ["The moon pulls the oceans and creates two tides a day."], objections: [] }],
      takeaway: "Tides follow the moon.",
    });
  });

  it("names what is missing so the repair turn can fix it", () => {
    expect(() => parseArgumentMap("no json here")).toThrow("not a JSON object");
    expect(() => parseArgumentMap(JSON.stringify({ claims: [{ claim: "x" }] }))).toThrow("thesis is missing");
    expect(() => parseArgumentMap(JSON.stringify({ thesis: "t", claims: [] }))).toThrow("at least one claim");
  });
});

describe("isQuoted", () => {
  it("matches evidence copied from the article, ignoring case, spacing, quotes and markdown marks", () => {
    expect(isQuoted("“The moon pulls the oceans and creates two tides a day.”", ARTICLE)).toBe(true);
    expect(isQuoted("spring tides   happen at new and full moon", ARTICLE)).toBe(true);
    expect(isQuoted("The sun causes neap tides.", ARTICLE)).toBe(false);
    expect(isQuoted("moon", ARTICLE)).toBe(false);
  });
});

describe("argument map page", () => {
  it("marks quoted evidence, escapes model text, and never contains a code fence", () => {
    const html = renderArgumentMap({
      thesis: "Tides <script>alert(1)</script> follow ```the moon```.",
      claims: [{ claim: "Two tides a day.", evidence: ["The moon pulls the oceans and creates two tides a day.", "Invented support."], objections: ["Local geography matters."] }],
      takeaway: "",
    }, { title: "Tide Study", url: "https://example.com/tides", text: ARTICLE });
    expect(html).toContain('<div class="lv-evidence is-quoted">The moon pulls the oceans and creates two tides a day.<span class="lv-tag">Quoted</span>');
    expect(html).toContain('<div class="lv-evidence">Invented support.<span class="lv-tag">Not found in the article</span>');
    expect(html).toContain("Local geography matters.");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("```");
  });

  it("sends the article text, clipped, with its capture metadata", () => {
    const prompt = argumentMapPrompt({ title: "Tide Study", summary: "Tides.", keyClaims: ["Moon"], text: "x".repeat(20000) });
    expect(prompt).toContain("Title: Tide Study\nSummary: Tides.\nKey claims noted at capture:\n- Moon\n<article>");
    expect(prompt).toContain("[article continues]");
    expect(prompt.length).toBeLessThan(16200);
  });
});
