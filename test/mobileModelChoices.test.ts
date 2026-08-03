import { describe, expect, it } from "vitest";
import { isMobileModelChoiceActive, mobileModelChoices } from "../src/view/mobileModelChoices";

describe("mobileModelChoices", () => {
  it("keeps configured local and endpoint models reachable when desktop controls are hidden", () => {
    expect(mobileModelChoices({
      ollamaModels: [],
      configuredOllamaModel: "llama3.1:8b",
      openaiCompatHost: "http://127.0.0.1:1234",
      openaiCompatModel: "mlx-3b",
    })).toEqual(expect.arrayContaining([
      { value: "ollama:llama3.1:8b", label: "llama3.1:8b · local", provider: "local" },
      { value: "custom:mlx-3b", label: "mlx-3b · endpoint", provider: "custom" },
    ]));
  });

  it("checks Claude when an unavailable configured local backend resolves to Anthropic", () => {
    const choices = mobileModelChoices({
      ollamaModels: [],
      configuredOllamaModel: "qwen3:8b",
      openaiCompatHost: "",
      openaiCompatModel: "",
    });

    expect(choices.filter((choice) => isMobileModelChoiceActive(choice, "anthropic", "claude-sonnet-5")))
      .toEqual([{ value: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "claude" }]);
  });
});
