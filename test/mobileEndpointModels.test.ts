import { describe, expect, it } from "vitest";
import { mobileModelChoices } from "../src/view/mobileModelChoices";

const base = {
  ollamaModels: [],
  configuredOllamaModel: "",
  openaiCompatHost: "http://127.0.0.1:1234",
  openaiCompatModel: "",
  openaiCompatModels: [] as string[],
};

const endpoints = (input: Parameters<typeof mobileModelChoices>[0]): string[] =>
  mobileModelChoices(input).filter((c) => c.provider === "custom").map((c) => c.value);

describe("mobileModelChoices — OpenAI-compatible endpoint", () => {
  it("offers every detected endpoint model, not just the configured one", () => {
    expect(endpoints({ ...base, openaiCompatModels: ["mlx-3b", "qwen-7b"] }))
      .toEqual(["custom:mlx-3b", "custom:qwen-7b"]);
  });

  it("offers detected models even when no endpoint model is configured yet", () => {
    // The reported bug: an unset openaiCompatModel used to hide the endpoint
    // entirely, so a picked LM Studio model never appeared in the picker.
    expect(endpoints({ ...base, openaiCompatModel: "", openaiCompatModels: ["mlx-3b"] }))
      .toEqual(["custom:mlx-3b"]);
  });

  it("keeps a configured model the endpoint did not report", () => {
    expect(endpoints({ ...base, openaiCompatModel: "saved-3b", openaiCompatModels: ["mlx-3b"] }))
      .toEqual(["custom:saved-3b", "custom:mlx-3b"]);
  });

  it("still offers the configured model with no detected list (offline endpoint)", () => {
    expect(endpoints({ ...base, openaiCompatModel: "mlx-3b" })).toEqual(["custom:mlx-3b"]);
  });

  it("offers nothing without a host, however many models were passed", () => {
    expect(endpoints({ ...base, openaiCompatHost: "", openaiCompatModel: "mlx-3b", openaiCompatModels: ["a"] }))
      .toEqual([]);
  });

  it("offers nothing when the host is set but no model is known", () => {
    expect(endpoints(base)).toEqual([]);
  });
});
