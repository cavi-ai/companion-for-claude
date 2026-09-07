import { describe, it, expect, vi } from "vitest";
import { ProviderRouter, migrateUtilityBackend } from "../../src/providers/router";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import type { Provider } from "../../src/providers/types";

function settings(overrides: Partial<PluginSettings>): PluginSettings {
  return { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-test", ...overrides };
}

function routerWithAnthropicEnv(overrides: Partial<PluginSettings>, env: Record<string, string>): ProviderRouter {
  const target = window as typeof window & { process?: { env?: Record<string, string | undefined> } };
  const previous = target.process;
  target.process = { env };
  try {
    return new ProviderRouter(settings({
      authMode: "environment",
      apiKey: "",
      oauthToken: "",
      baseUrl: "",
      utilityBackend: "claude",
      ...overrides,
    }));
  } finally {
    target.process = previous;
  }
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

  it("keeps the configured custom utility backend when its host is missing", () => {
    const r = new ProviderRouter(settings({ utilityBackend: "custom", openaiCompatHost: "" }));
    expect(r.resolve("utility").provider.id).toBe("openai-compat");
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

describe("ProviderRouter.resolveUtilityForRuntime", () => {
  it("does not return a callable provider for a mobile loopback endpoint before consent", () => {
    const configured = settings({ utilityBackend: "ollama", ollamaHost: "http://localhost:11434" });
    const r = new ProviderRouter(configured);

    expect(r.resolveUtilityForRuntime({ isMobile: true })).toEqual({
      state: "unavailable-loopback",
      backend: "ollama",
      endpoint: "http://localhost:11434",
    });
    expect(configured.utilityBackend).toBe("ollama");
  });

  it("selects a non-loopback configured endpoint on mobile", () => {
    const r = new ProviderRouter(settings({
      utilityBackend: "custom",
      openaiCompatHost: "http://192.168.1.24:1234",
      openaiCompatModel: "mlx-3b",
    }));

    const result = r.resolveUtilityForRuntime({ isMobile: true });
    expect(result.state).toBe("configured-provider");
    if (result.state !== "configured-provider") throw new Error("expected a configured provider");
    expect(result.provider.id).toBe("openai-compat");
    expect(result.model).toBe("mlx-3b");
  });

  it("selects Claude only when the session approved mobile loopback fallback", () => {
    const r = new ProviderRouter(settings({
      utilityBackend: "ollama",
      ollamaHost: "http://127.0.0.1:11434",
      model: "claude-sonnet-5-20260203",
    }));

    const result = r.resolveUtilityForRuntime({ isMobile: true, fallbackApproval: "allow" });
    expect(result.state).toBe("approved-Claude-fallback");
    if (result.state !== "approved-Claude-fallback") throw new Error("expected an approved fallback");
    expect(result.provider.id).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-5-20260203");
  });

  it("uses the environment auth gateway as the Claude policy and attribution endpoint", () => {
    const r = routerWithAnthropicEnv({}, {
      ANTHROPIC_API_KEY: "sk-ant-api-env",
      ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
    });

    const result = r.resolveUtilityForRuntime({ isMobile: true });

    expect(result.state).toBe("configured-provider");
    if (result.state !== "configured-provider") throw new Error("expected configured provider");
    expect(result.provider).toBe(r.anthropic);
    expect(result.endpoint).toBe("https://gateway.example.com/anthropic");
  });

  it.each([
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["ftp://gateway.example.com/v1", "(invalid endpoint)"],
    ["https://alice:supersecret@gateway.example.com/v1", "https://gateway.example.com/v1"],
    ["https://gateway.example.com/v1?token=private", "https://gateway.example.com/v1"],
    ["https://gateway.example.com/v1#private", "https://gateway.example.com/v1"],
  ])("rejects and redacts an unusable mobile environment gateway %s", (baseUrl, displayed) => {
    const r = routerWithAnthropicEnv({}, {
      ANTHROPIC_API_KEY: "sk-ant-api-env",
      ANTHROPIC_BASE_URL: baseUrl,
    });

    const result = r.resolveUtilityForRuntime({ isMobile: true });

    expect(result.state).toBe("unavailable-without-Claude");
    if (result.state !== "unavailable-without-Claude") throw new Error("expected unavailable provider");
    expect(result.endpoint).toBe(displayed);
    expect("provider" in result).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/alice|supersecret|token=private/i);
  });

  it("attributes environment-mode Anthropic failures to the sanitized resolved gateway", async () => {
    const r = routerWithAnthropicEnv({}, {
      ANTHROPIC_API_KEY: "sk-ant-api-env",
      ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
    });
    const selection = r.resolveUtilityForRuntime({ isMobile: true });
    if (selection.state !== "configured-provider") throw new Error("expected configured provider");
    vi.spyOn(r.anthropic, "complete").mockRejectedValue(new Error("failed to fetch"));

    await expect(r.completeResolved(selection, { system: "sys", user: "private" })).rejects.toThrow(
      /Anthropic at https:\/\/gateway\.example\.com\/anthropic/i,
    );
  });

  it("does not offer a local utility fallback through an invalid environment-mode Claude gateway", () => {
    const r = routerWithAnthropicEnv({
      utilityBackend: "ollama",
      ollamaHost: "http://localhost:11434",
    }, {
      ANTHROPIC_API_KEY: "sk-ant-api-env",
      ANTHROPIC_BASE_URL: "https://alice:supersecret@gateway.example.com/v1?token=private",
    });

    const result = r.resolveUtilityForRuntime({ isMobile: true });

    expect(result).toEqual({
      state: "unavailable-without-Claude",
      backend: "claude",
      endpoint: "https://gateway.example.com/v1",
      reason: "invalid-endpoint",
    });
    expect("provider" in result).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/alice|supersecret|token=private/i);
  });
});

describe("ProviderRouter.completeResolved", () => {
  it("completes with the provider and model selected before enrichment", async () => {
    const r = new ProviderRouter(settings({ utilityBackend: "ollama", ollamaUtilityModel: "qwen3:1.7b" }));
    const selected = r.resolve("utility");
    const complete = vi.spyOn(selected.provider, "complete").mockResolvedValue("{}");

    const result = await r.completeResolved(selected, { system: "sys", user: "note" });

    expect(result.provider).toBe(selected.provider);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen3:1.7b" }));
  });

  it("attributes provider failures to the pinned sanitized endpoint", async () => {
    const r = new ProviderRouter(settings({ utilityBackend: "custom" }));
    const selected = {
      provider: r.openaiCompat,
      model: "remote-model",
      endpoint: "https://alice:supersecret@models.example.com/v1",
    };
    vi.spyOn(r.openaiCompat, "complete").mockRejectedValue(
      new Error("gateway exploded at https://alice:supersecret@models.example.com/v1"),
    );

    await expect(r.completeResolved(selected, { system: "sys", user: "private note" }))
      .rejects.toThrow(/OpenAI-compatible endpoint at https:\/\/models\.example\.com\/v1.*gateway exploded/i);
    await expect(r.completeResolved(selected, { system: "sys", user: "private note" }))
      .rejects.not.toThrow(/alice|supersecret/i);
  });

  it("identifies a pinned Anthropic gateway on network failure", async () => {
    const r = new ProviderRouter(settings({ utilityBackend: "claude" }));
    vi.spyOn(r.anthropic, "complete").mockRejectedValue(new Error("failed to fetch"));

    await expect(r.completeResolved({
      provider: r.anthropic,
      model: "claude-test",
      endpoint: "https://gateway.example.com/v1",
    }, { system: "sys", user: "private note" })).rejects.toThrow(
      /Anthropic at https:\/\/gateway\.example\.com\/v1/i,
    );
  });

  it("preserves the original provider failure as the attributed error cause", async () => {
    const r = new ProviderRouter(settings({ utilityBackend: "claude" }));
    const original = new Error("failed to fetch");
    vi.spyOn(r.anthropic, "complete").mockRejectedValue(original);

    await expect(r.completeResolved({
      provider: r.anthropic,
      model: "claude-test",
      endpoint: "https://gateway.example.com/v1",
    }, { system: "sys", user: "private note" })).rejects.toMatchObject({ cause: original });
  });
});

describe("ProviderRouter.complete utility privacy boundary", () => {
  it("rejects utility completion before provider I/O when no runtime resolver is installed", async () => {
    const r = new ProviderRouter(settings({ utilityBackend: "claude" }));
    const complete = vi.spyOn(r.anthropic, "complete").mockResolvedValue("unsafe");

    await expect(r.complete("utility", { system: "sys", user: "private note" }))
      .rejects.toThrow(/runtime resolver/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the runtime resolver's pinned provider and model for utility completion", async () => {
    let requestModel = "";
    const provider: Provider = {
      id: "ollama",
      label: "Approved utility",
      hasCredentials: () => true,
      stream: async () => undefined,
      complete: async (request) => { requestModel = request.model; return "safe"; },
      test: async () => ({ ok: true, detail: "ready" }),
    };
    const r = new ProviderRouter(
      settings({ utilityBackend: "claude" }),
      async () => ({ provider, model: "approved-model", endpoint: "http://192.168.1.24:11434" }),
    );

    const result = await r.complete("utility", { system: "sys", user: "private note" });

    expect(result).toEqual({ text: "safe", provider });
    expect(requestModel).toBe("approved-model");
  });
});

describe("ProviderRouter.localFallback", () => {
  it("prefers Ollama when reachable", async () => {
    const r = new ProviderRouter(settings({ ollamaModel: "qwen2.5" }));
    vi.spyOn(r.ollama, "listModels").mockResolvedValue(["qwen2.5"]);
    const fb = await r.localFallback();
    expect(fb?.provider.id).toBe("ollama");
    expect(fb?.model).toBe("qwen2.5");
    await expect(r.localAvailable()).resolves.toBe(true);
  });

  it("falls through to the custom endpoint when Ollama is down", async () => {
    const r = new ProviderRouter(settings({ openaiCompatHost: "http://localhost:1234", openaiCompatModel: "mlx-3b" }));
    vi.spyOn(r.ollama, "listModels").mockResolvedValue([]);
    vi.spyOn(r.openaiCompat, "listModels").mockResolvedValue(["mlx-3b"]);
    const fb = await r.localFallback();
    expect(fb?.provider.id).toBe("openai-compat");
    expect(fb?.model).toBe("mlx-3b");
  });

  it("null when neither backend is usable", async () => {
    const r = new ProviderRouter(settings({}));
    vi.spyOn(r.ollama, "listModels").mockResolvedValue([]);
    await expect(r.localFallback()).resolves.toBeNull();
    await expect(r.localAvailable()).resolves.toBe(false);
  });

  it("never treats an unmodeled custom endpoint as a fallback", async () => {
    const r = new ProviderRouter(settings({ openaiCompatHost: "http://localhost:1234", openaiCompatModel: "" }));
    vi.spyOn(r.ollama, "listModels").mockResolvedValue([]);
    await expect(r.localFallback()).resolves.toBeNull();
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

import { ClaudeCliProvider } from "../../src/providers/claudeCli";

const cliRuntime = (loggedIn: boolean) => ({
  findClaude: async () => ({ executable: "/usr/local/bin/claude", version: "2.1.257" }),
  authStatus: async () => ({ loggedIn, method: "claude.ai" }),
  writeSystemPromptFile: async () => "/tmp/p.md",
  removeFile: async () => undefined,
  spawn: () => { throw new Error("no spawn in router tests"); },
});

describe("ProviderRouter — claude-cli backend", () => {
  it("routes chat to the CLI provider once it is signed in", async () => {
    const r = new ProviderRouter(settings({ chatBackend: "claude-cli", apiKey: "" }), undefined, { cliRuntime: cliRuntime(true) });
    expect(r.chatProvider().provider.id).toBe("anthropic");
    await r.claudeCli.refresh();
    expect(r.chatProvider().provider.id).toBe("claude-cli");
    expect(r.chatProvider().model).toBe(DEFAULT_SETTINGS.model);
    expect(r.get("claude-cli")).toBeInstanceOf(ClaudeCliProvider);
  });
  it("falls back to the API key when the CLI is signed out or the runtime is absent (mobile)", async () => {
    const out = new ProviderRouter(settings({ chatBackend: "claude-cli" }), undefined, { cliRuntime: cliRuntime(false) });
    await out.claudeCli.refresh();
    expect(out.chatProvider().provider.id).toBe("anthropic");
    const mobile = new ProviderRouter(settings({ chatBackend: "claude-cli" }), undefined, { cliRuntime: null });
    expect(mobile.claudeCli.available()).toBe(false);
    expect(mobile.chatProvider().provider.id).toBe("anthropic");
  });
  it("reports tool capability and capabilities for every backend", async () => {
    const cli = new ProviderRouter(settings({ chatBackend: "claude-cli", apiKey: "" }), undefined, { cliRuntime: cliRuntime(true) });
    await cli.claudeCli.refresh();
    expect(await cli.chatToolCapable()).toBe(true);
    expect(cli.chatCapabilities()).toEqual({ agentActions: true, claudeControls: false, metered: false, local: false, cli: true });
    const api = new ProviderRouter(settings({}));
    expect(api.chatCapabilities()).toEqual({ agentActions: true, claudeControls: true, metered: true, local: false, cli: false });
    const local = new ProviderRouter(settings({ chatBackend: "local" }));
    expect(local.chatCapabilities()).toEqual({ agentActions: false, claudeControls: false, metered: false, local: true, cli: false });
  });
  it("never routes utility work to the CLI", async () => {
    const r = new ProviderRouter(settings({ chatBackend: "claude-cli", utilityBackend: "claude" }), undefined, { cliRuntime: cliRuntime(true) });
    await r.claudeCli.refresh();
    expect(r.resolve("utility").provider.id).toBe("anthropic");
  });
});
