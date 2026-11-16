import { describe, expect, it } from "vitest";
import { mergeModelLists, parseModelList } from "../src/claude/modelList";
import type { ClaudeModel } from "../src/types";

const response = {
  data: [
    { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-06-01T00:00:00Z" },
    { type: "model", id: "claude-new-6", display_name: "Claude New 6", created_at: "2026-10-01T00:00:00Z" },
    { type: "model", id: "claude-old-4", display_name: "Claude Old 4", created_at: "2025-02-01T00:00:00Z" },
  ],
  has_more: false,
  first_id: "claude-sonnet-5-5",
  last_id: "claude-old-4",
};

const curated: ClaudeModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Deep reasoning" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced" },
];

describe("parseModelList", () => {
  it("reads id, display name and creation time from a models response", () => {
    expect(parseModelList(response)).toEqual([
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", created: "2026-06-01T00:00:00Z" },
      { id: "claude-new-6", label: "Claude New 6", created: "2026-10-01T00:00:00Z" },
      { id: "claude-old-4", label: "Claude Old 4", created: "2025-02-01T00:00:00Z" },
    ]);
  });

  it("uses the id as label when display_name is missing", () => {
    expect(parseModelList({ data: [{ type: "model", id: "claude-x-1" }] })).toEqual([{ id: "claude-x-1", label: "claude-x-1" }]);
  });

  it("ignores non-model entries and entries without an id", () => {
    const parsed = parseModelList({ data: [null, 3, "x", { type: "other", id: "a" }, { type: "model" }, { type: "model", id: "  " }, { type: "model", id: "ok", display_name: "Ok" }] });
    expect(parsed.map((m) => m.id)).toEqual(["ok"]);
  });

  it.each([null, undefined, 5, "text", [], {}, { data: "no" }, { data: null }])("returns an empty list for malformed input %j", (input) => {
    expect(parseModelList(input)).toEqual([]);
  });
});

describe("mergeModelLists", () => {
  it("keeps curated order and labels, then fetched-only models newest first", () => {
    const merged = mergeModelLists(parseModelList(response), curated);
    expect(merged.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-new-6", "claude-old-4"]);
    expect(merged[1]).toEqual({ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced" });
    expect(merged[2]).toEqual({ id: "claude-new-6", label: "Claude New 6" });
  });

  it("dedupes repeated ids", () => {
    const fetched = [...parseModelList(response), ...parseModelList(response)];
    const merged = mergeModelLists(fetched, curated);
    expect(new Set(merged.map((m) => m.id)).size).toBe(merged.length);
  });

  it("returns the curated list when nothing was fetched", () => {
    expect(mergeModelLists([], curated)).toEqual(curated);
  });

  it("orders fetched-only models without a date after dated ones", () => {
    const merged = mergeModelLists([{ id: "a", label: "A" }, { id: "b", label: "B", created: "2026-01-01T00:00:00Z" }], []);
    expect(merged.map((m) => m.id)).toEqual(["b", "a"]);
  });
});
