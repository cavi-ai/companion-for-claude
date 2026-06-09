import { describe, it, expect } from "vitest";
import { digestTranscript } from "../src/memory/transcript";

const rec = (o: object): string => JSON.stringify(o);

const jsonl = [
  rec({ type: "user", timestamp: "2026-06-03T00:00:00Z", sessionId: "s1", gitBranch: "claude/x", message: { role: "user", content: "Fix the parser" } }),
  rec({
    type: "assistant",
    timestamp: "2026-06-03T00:00:05Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 40 },
      content: [
        { type: "text", text: "On it." },
        { type: "tool_use", name: "Edit", input: { file_path: "src/parse.ts" } },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      ],
    },
  }),
  rec({
    type: "assistant",
    timestamp: "2026-06-03T00:00:09Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: { input_tokens: 50, output_tokens: 20 },
      content: [
        { type: "text", text: "Done — tests pass." },
        { type: "tool_use", name: "Read", input: { file_path: "src/parse.ts" } },
      ],
    },
  }),
  "{ not valid json",
  rec({ type: "user", message: { role: "user", content: "<system-reminder>noise</system-reminder>" } }),
  rec({ type: "system", message: { content: "boot" } }),
].join("\n");

describe("digestTranscript", () => {
  const d = digestTranscript(jsonl);

  it("extracts clean prose turns, skipping noise + malformed lines", () => {
    expect(d.prose).toEqual([
      { role: "user", text: "Fix the parser" },
      { role: "assistant", text: "On it." },
      { role: "assistant", text: "Done — tests pass." },
    ]);
    expect(d.userTurns).toBe(1);
    expect(d.assistantTurns).toBe(2);
  });

  it("captures tool actions + the files touched", () => {
    expect(d.toolActions).toEqual([
      { tool: "Edit", target: "src/parse.ts" },
      { tool: "Bash", target: "npm test" },
      { tool: "Read", target: "src/parse.ts" },
    ]);
    expect(d.filesTouched).toEqual(["src/parse.ts"]);
  });

  it("sums token usage and captures provenance", () => {
    expect(d.inputTokens).toBe(150);
    expect(d.outputTokens).toBe(60);
    expect(d.model).toBe("claude-opus-4-8");
    expect(d.gitBranch).toBe("claude/x");
    expect(d.sessionId).toBe("s1");
    expect(d.startedAt).toBe("2026-06-03T00:00:00Z");
    expect(d.endedAt).toBe("2026-06-03T00:00:09Z");
  });

  it("captures cwd from the first record that has it", () => {
    const j = [
      JSON.stringify({ type: "user", cwd: "/Volumes/MIRZA/vault", sessionId: "s9", message: { role: "user", content: "hi" } }),
    ].join("\n");
    expect(digestTranscript(j).cwd).toBe("/Volumes/MIRZA/vault");
  });
});
