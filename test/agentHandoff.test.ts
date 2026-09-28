import { describe, it, expect } from "vitest";
import { buildHandoffPacket, formatHandoff, handoffResumePrompt, HANDOFF_TEXT_MAX } from "../src/agent/handoff";
import type { ToolTraceEntry } from "../src/types";

const entry = (name: string, argsSummary: string, ok = true): ToolTraceEntry => ({ name, argsSummary, resultPreview: "…", ok });

describe("buildHandoffPacket", () => {
  it("collects tools and targets in first-use order, deduped", () => {
    const packet = buildHandoffPacket([
      entry("vault_search", '{"query":"alpha"}'),
      entry("note_read", '{"path":"Notes/A.md"}'),
      entry("note_read", '{"path":"Notes/B.md"}'),
      entry("note_read", '{"path":"Notes/A.md"}'),
    ], 10);
    expect(packet.iterations).toBe(10);
    expect(packet.tools).toEqual(["vault_search", "note_read"]);
    expect(packet.targets).toEqual(["Notes/A.md", "Notes/B.md"]);
    expect(packet.failed).toEqual([]);
  });

  it("records tools whose result was an error", () => {
    const packet = buildHandoffPacket([entry("note_update", '{"path":"A.md"}', false)]);
    expect(packet.failed).toEqual(["note_update"]);
  });

  it("ignores unparseable args summaries", () => {
    const packet = buildHandoffPacket([entry("vault_search", "not json")]);
    expect(packet.targets).toEqual([]);
  });

  it("handles an empty trace (CLI turns carry no per-tool args)", () => {
    const packet = buildHandoffPacket([]);
    expect(packet).toEqual({ tools: [], targets: [], failed: [] });
  });
});

describe("formatHandoff", () => {
  it("includes the iteration count only when known", () => {
    expect(formatHandoff(buildHandoffPacket([], 10))).toContain("Tool iterations used: 10");
    expect(formatHandoff(buildHandoffPacket([]))).not.toContain("Tool iterations used");
  });

  it("stays within the receipt size cap", () => {
    const long = Array.from({ length: 12 }, (_, i) => entry("note_read", `{"path":"Notes/${"x".repeat(200)}-${i}.md"}`));
    const text = formatHandoff(buildHandoffPacket(long, 10));
    expect(text.length).toBeLessThanOrEqual(HANDOFF_TEXT_MAX + 1);
  });
});

describe("handoffResumePrompt", () => {
  it("carries the packet and the no-repeat instruction", () => {
    const prompt = handoffResumePrompt("Tools used: note_read");
    expect(prompt).toContain("Tools used: note_read");
    expect(prompt).toContain("tool-iteration limit");
    expect(prompt).toContain("Do not repeat completed writes");
  });
});
