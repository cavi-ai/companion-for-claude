import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NATIVE_MODEL, nativeRequestURL, validateNativeRequest, validateNativeResult, type NativeRequest } from "../src/native/handoff";

const id = "11111111-2222-4333-8444-555555555555";
const request: NativeRequest = { version: 1, id, createdAt: 100, expiresAt: 3700, vaultName: "Research",
  sourcePath: "Note.md", input: "A source paragraph.", instruction: "Summarize this paragraph." };
const result = { version: 1, id, model: "mlx-community/Qwen3.5-0.8B-4bit", revision: "da28692b5f139cb0ec58a356b437486b7dac7462", output: "A summary.", instruction: request.instruction };

describe("native MLX handoff", () => {
  it("keeps native download pins aligned with the accepted result contract", () => {
    const model = JSON.parse(readFileSync(new URL("../../native-ios/Resources/Model.json", import.meta.url), "utf8")) as typeof NATIVE_MODEL;
    expect({ repo: model.repo, revision: model.revision }).toEqual(NATIVE_MODEL);
  });
  it("opens only the matching job and keeps passage content out of the URL", () => {
    const url = new URL(nativeRequestURL(`.obsidian/plugins/claude-companion/native-jobs/${id}.request.json`, id));
    expect(url.protocol).toBe("cavi-companion:");
    expect(url.searchParams.get("id")).toBe(id);
    expect(url.href).not.toContain("paragraph");
    expect(() => nativeRequestURL(`../.obsidian/plugins/claude-companion/native-jobs/${id}.request.json`, id)).toThrow();
  });
  it("rejects expired, oversized, or malformed requests", () => {
    expect(validateNativeRequest(request, 101)).toEqual(request);
    for (const invalid of [{ ...request, expiresAt: 99 }, { ...request, input: "a".repeat(12001) },
      { ...request, id: "../file" }, { ...request, createdAt: NaN }, { ...request, instruction: "" }]) {
      expect(() => validateNativeRequest(invalid, 101)).toThrow();
    }
  });
  it("accepts only nonempty output from this request and pinned model", () => {
    expect(validateNativeResult(result, request, 101)).toBe("A summary.");
    for (const invalid of [{ ...result, id: "other" }, { ...result, output: "" },
      { ...result, output: "a".repeat(16385) }, { ...result, model: "other/model" }, { ...result, revision: "main" }]) {
      expect(() => validateNativeResult(invalid, request, 101)).toThrow();
    }
    expect(() => validateNativeResult(result, request, 3701)).toThrow();
  });
});
