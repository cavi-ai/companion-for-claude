import { describe, expect, it } from "vitest";
import { systemWithSchema } from "../../src/providers/schemaPrompt";

const schema = { type: "object", required: ["verdicts"] };

describe("systemWithSchema", () => {
  it("appends the schema to the system prompt of a JSON request", () => {
    expect(systemWithSchema({ system: "Judge tags.", responseFormat: "json", responseSchema: schema })).toBe(
      'Judge tags.\n\nReply with one JSON object that matches this JSON Schema:\n{"type":"object","required":["verdicts"]}',
    );
  });

  it("uses the schema alone when the system prompt is empty", () => {
    expect(systemWithSchema({ system: "", responseFormat: "json", responseSchema: schema })).toBe(
      'Reply with one JSON object that matches this JSON Schema:\n{"type":"object","required":["verdicts"]}',
    );
  });

  it("leaves the system prompt alone without JSON format or without a schema", () => {
    expect(systemWithSchema({ system: "Judge tags.", responseSchema: schema })).toBe("Judge tags.");
    expect(systemWithSchema({ system: "Judge tags.", responseFormat: "json" })).toBe("Judge tags.");
  });
});
