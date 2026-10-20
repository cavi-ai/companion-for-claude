import { describe, expect, it } from "vitest";
import { formatTime, parseTime, parseTranscript, transcriptLines, youtubeId, youtubeLink } from "../../src/living/transcript";

describe("times", () => {
  it("parse m:ss and h:mm:ss and format them back", () => {
    expect(parseTime("0:45")).toBe(45);
    expect(parseTime("12:05")).toBe(725);
    expect(parseTime("1:02:03")).toBe(3723);
    expect(parseTime("0:75")).toBeNull();
    expect(parseTime("1:75:00")).toBeNull();
    expect(parseTime("45")).toBeNull();
    expect(formatTime(45)).toBe("0:45");
    expect(formatTime(3723)).toBe("1:02:03");
  });
});

describe("parseTranscript", () => {
  it("reads Defuddle's bold and bracketed timestamp lines and the chapters the video declares", () => {
    const text = [
      "## Transcript",
      "",
      "### Intro",
      "",
      "**0:00** · Welcome to the talk.",
      "**0:45** · First, tides.",
      "",
      "### Waves",
      "",
      "- [2:10] Then wind and waves.",
      "A line without a time.",
    ].join("\n");
    expect(parseTranscript(text)).toEqual({
      segments: [{ start: 0, text: "Welcome to the talk." }, { start: 45, text: "First, tides." }, { start: 130, text: "Then wind and waves." }],
      chapters: [{ start: 0, title: "Intro" }, { start: 130, title: "Waves" }],
    });
  });

  it("is null below two timestamped lines, so ordinary notes are not transcripts", () => {
    expect(parseTranscript("Meeting at 10:30.\n**0:00** · Only one line.")).toBeNull();
  });

  it("clips prompt lines and says the transcript continues", () => {
    const transcript = parseTranscript("**0:00** · aaaa\n**0:10** · bbbb\n**0:20** · cccc")!;
    expect(transcriptLines(transcript, 20)).toBe("0:00 aaaa\n0:10 bbbb\n[transcript continues]");
  });
});

describe("YouTube links", () => {
  it("find the id in watch, short, embed and youtu.be URLs", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=abc123XYZ00&list=x")).toBe("abc123XYZ00");
    expect(youtubeId("https://m.youtube.com/shorts/abc123XYZ00")).toBe("abc123XYZ00");
    expect(youtubeId("https://youtu.be/abc123XYZ00?t=5")).toBe("abc123XYZ00");
    expect(youtubeId("https://www.youtube.com/embed/abc123XYZ00")).toBe("abc123XYZ00");
    expect(youtubeId("https://vimeo.com/12345")).toBeNull();
    expect(youtubeId("not a url")).toBeNull();
    expect(youtubeLink("abc123XYZ00", 130.6)).toBe("https://www.youtube.com/watch?v=abc123XYZ00&t=130s");
  });
});
