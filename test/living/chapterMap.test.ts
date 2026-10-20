import { describe, expect, it } from "vitest";
import { chapterMapPrompt, parseChapterMap, renderChapterMap, videoFields, watchLinks } from "../../src/living/chapterMap";
import { parseTranscript } from "../../src/living/transcript";

const TRANSCRIPT = parseTranscript([
  "**0:00** · Welcome to the talk.",
  "**0:45** · First we cover how the moon moves the tides.",
  "**2:10** · Then we cover how wind makes waves.",
  "**4:30** · Thanks for watching.",
].join("\n"))!;

describe("parseChapterMap", () => {
  it("snaps every time to the nearest transcript line, sorts, dedupes, and drops times past the end", () => {
    const raw = JSON.stringify({
      summary: " Tides and waves. ",
      chapters: [
        { start: "2:08", title: "Waves", summary: "Wind." },
        { start: "0:44", title: "Tides", summary: "Moon." },
        { start: "0:46", title: "Tides again", summary: "" },
        { start: "9:00", title: "After the end", summary: "" },
        { start: "soon", title: "No time", summary: "" },
      ],
      key_moments: [{ time: "2:11", moment: "Wind makes waves" }, { time: "0:01", moment: " " }],
    });
    expect(parseChapterMap(raw, TRANSCRIPT)).toEqual({
      summary: "Tides and waves.",
      chapters: [{ start: 45, title: "Tides", summary: "Moon." }, { start: 130, title: "Waves", summary: "Wind." }],
      moments: [{ time: 130, moment: "Wind makes waves" }],
    });
  });

  it("names the problem when no chapter lands inside the transcript", () => {
    expect(() => parseChapterMap(JSON.stringify({ summary: "", chapters: [{ start: "20:00", title: "Late" }] }), TRANSCRIPT)).toThrow("at least one chapter");
    expect(() => parseChapterMap("nope", TRANSCRIPT)).toThrow("not a JSON object");
  });
});

describe("chapter map output", () => {
  const map = { summary: "Tides <b>and</b> ```waves```.", chapters: [{ start: 0, title: "Welcome", summary: "" }, { start: 130, title: "Waves [part 2]", summary: "Wind." }], moments: [{ time: 130, moment: "Wind makes waves" }] };

  it("renders one button per chapter with the transcript embedded, escaped and fence-safe", () => {
    const html = renderChapterMap(map, { title: "Tide Talk", channel: "Ocean Lab", url: "https://youtu.be/abc123XYZ00", transcript: TRANSCRIPT });
    expect(html.match(/class="lv-chapter"/g)).toHaveLength(2);
    expect(html).toContain('data-jump="130"');
    expect(html).toContain("Tides &lt;b&gt;and&lt;/b&gt;");
    expect(html).toContain("Then we cover how wind makes waves.");
    expect(html).not.toContain("```");
  });

  it("links each chapter to the video at its start and fills the video's derived fields", () => {
    expect(watchLinks(map, "abc123XYZ00")).toBe([
      "## Watch",
      "",
      "- [0:00 Welcome](https://www.youtube.com/watch?v=abc123XYZ00&t=0s)",
      "- [2:10 Waves part 2](https://www.youtube.com/watch?v=abc123XYZ00&t=130s)",
      "",
    ].join("\n"));
    expect(watchLinks(map, null)).toBe("");
    expect(videoFields(map)).toEqual({ chapters: 2, key_moments: ["2:10 — Wind makes waves"], transcript_summary: "Tides <b>and</b> ```waves```." });
  });

  it("prompts with the declared chapters and the transcript lines", () => {
    const prompt = chapterMapPrompt({ title: "Tide Talk", channel: "Ocean Lab", transcript: { ...TRANSCRIPT, chapters: [{ start: 130, title: "Waves" }] } });
    expect(prompt).toContain("Channel: Ocean Lab\nChapters the video declares:\n2:10 Waves\n<transcript>\n0:00 Welcome to the talk.");
  });
});
