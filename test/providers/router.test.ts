import { describe, it, expect } from "vitest";
import { ProviderRouter, migrateUtilityBackend } from "../../src/providers/router";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";

function settings(overrides: Partial<PluginSettings>): PluginSettings {
  return { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-test", ...overrides };
}

describe("ProviderRouter.resolve", () => {
  it("routes utility to claude by default", () => {
    const r = new ProviderRouter(settings({}));
    expect(r.resolve("utility").provider.id).toBe("anthropic");
  });

  it("routes utility to ollama with the chat model when no utility model is set", () => {
    const r = new ProviderRouter(settings({ utilityBackend: "ollama", ollamaModel: "qwen2.5" }));
    const res = r.resolve("utility");
    expect(res.provider.id).toBe("ollama");
    expect(res.model).toBe("qwen2.5");
  });

  it("splits utility onto its own smaller model when configured", () => {
    const r = new ProviderRouter(settings({ utilityBackend: "ollama", ollamaModel: "qwen2.5", ollamaUtilityModel: "qwen2.5:1.5b" }));
    const res = r.resolve("utility");
    expect(res.model).toBe("qwen2.5:1.5b");
    // …while local chat keeps the chat model.
    const chat = new ProviderRouter(settings({ chatBackend: "local", ollamaModel: "qwen2.5", ollamaUtilityModel: "qwen2.5:1.5b" }));
    expect(chat.resolve("chat").model).toBe("qwen2.5");
  });

  it("routes utility to the custom endpoint when configured", () => {
    const r = new ProviderRouter(settings({ utilityBackend: "custom", openaiCompatHost: "http://localhost:1234", openaiCompatModel: "mlx-3b" }));
    const res = r.resolve("utility");
    expect(res.provider.id).toBe("openai-compat");
    expect(res.model).toBe("mlx-3b");
  });

  it("falls back to claude for a custom utility backend with no host", () => {
    const r = new ProviderRouter(settings({ utilityBackend: "custom", openaiCompatHost: "" }));
    expect(r.resolve("utility").provider.id).toBe("anthropic");
  });

  it("routes chat to the custom endpoint when the backend is custom", () => {
    const r = new ProviderRouter(settings({ chatBackend: "custom", openaiCompatHost: "http://localhost:1234", openaiCompatModel: "mlx-3b" }));
    const res = r.resolve("chat");
    expect(res.provider.id).toBe("openai-compat");
    expect(res.model).toBe("mlx-3b");
  });

  it("falls back to claude chat when the custom endpoint is unconfigured", () => {
    const r = new ProviderRouter(settings({ chatBackend: "custom", openaiCompatHost: "" }));
    expect(r.resolve("chat").provider.id).toBe("anthropic");
  });

  it("get() returns each provider by id", () => {
    const r = new ProviderRouter(settings({}));
    expect(r.get("anthropic").id).toBe("anthropic");
    expect(r.get("ollama").id).toBe("ollama");
    expect(r.get("openai-compat").id).toBe("openai-compat");
  });
});

describe("migrateUtilityBackend", () => {
  it("maps a persisted localUtilityEnabled=true to ollama", () => {
    expect(migrateUtilityBackend({ localUtilityEnabled: true })).toBe("ollama");
  });
  it("undefined for users who never opted in — the claude default applies", () => {
    expect(migrateUtilityBackend({ localUtilityEnabled: false })).toBeUndefined();
    expect(migrateUtilityBackend({})).toBeUndefined();
    expect(migrateUtilityBackend(null)).toBeUndefined();
  });
  it("undefined once utilityBackend is stored — respect the new key", () => {
    expect(migrateUtilityBackend({ utilityBackend: "custom", localUtilityEnabled: true })).toBeUndefined();
  });
});
