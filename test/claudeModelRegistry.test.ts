import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));
vi.mock("obsidian", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), requestUrl: requestUrlMock }));

import { AnthropicProvider } from "../src/providers/anthropic";
import { buildClaudeModels } from "../src/composition/models";
import { CLAUDE_MODELS } from "../src/claude/models";
import { modelLabel } from "../src/claude/models";
import { DEFAULT_SETTINGS } from "../src/types";
import { ModelCatalogSource } from "../src/view/chat/modelCatalog";
import { mobileModelChoices } from "../src/view/mobileModelChoices";
import type { ComposerHost } from "../src/view/chat/hosts";

const apiResponse = {
  data: [
    { type: "model", id: "claude-sonnet-5-5", display_name: "Sonnet 5.5 (api name)", created_at: "2026-06-01T00:00:00Z" },
    { type: "model", id: "claude-brand-new-7", display_name: "Claude Brand New 7", created_at: "2026-11-01T00:00:00Z" },
  ],
  has_more: false,
};

function rig(over: { chatBackend?: "auto" | "claude" | "claude-cli"; apiKey?: string } = {}) {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), chatBackend: over.chatBackend ?? "claude", apiKey: over.apiKey ?? "sk-ant-api-one" };
  const state = { provider: null as AnthropicProvider | null };
  const build = (): AnthropicProvider => new AnthropicProvider({ mode: "apiKey", apiKey: settings.apiKey, oauthToken: "", baseUrl: "", env: {} });
  const host = { settings, router: () => ({ anthropic: (state.provider = build()) }) };
  const registry = buildClaudeModels(host as never);
  return { settings, registry, host };
}

const values = (source: ModelCatalogSource, backend: string): string[] =>
  source.snapshot().find((g) => g.backend === backend)!.choices.map((c) => c.value);

beforeEach(() => requestUrlMock.mockReset());

describe("Claude models from the Models API", () => {
  it("offers an id that exists only in the fetched list, labelled by display name", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: apiResponse, text: "" });
    const { settings, registry, host } = rig();
    const source = new ModelCatalogSource(host as unknown as ComposerHost, () => settings.model, false, registry);
    expect(values(source, "claude")).not.toContain("claude:claude-brand-new-7");
    const update = vi.fn();
    await source.refresh(update);
    expect(values(source, "claude")).toContain("claude:claude-brand-new-7");
    const choice = source.snapshot().find((g) => g.backend === "claude")!.choices.find((c) => c.value === "claude:claude-brand-new-7");
    expect(choice?.label).toBe("Claude Brand New 7");
    expect(source.snapshot().find((g) => g.backend === "claude")!.choices.find((c) => c.value === "claude:claude-sonnet-5-5")?.label).toBe("Claude Sonnet 5.5");
    expect(update).toHaveBeenCalled();
    expect(modelLabel("claude-brand-new-7", registry.models())).toBe("Claude Brand New 7");
    expect(mobileModelChoices({ ollamaModels: [], configuredOllamaModel: "", openaiCompatHost: "", openaiCompatModel: "", claudeModels: registry.models() }).map((c) => c.value)).toContain("claude-brand-new-7");
  });

  it("keeps the curated choices when the fetch fails", async () => {
    requestUrlMock.mockResolvedValue({ status: 500, json: {}, text: "boom" });
    const { settings, registry, host } = rig();
    const source = new ModelCatalogSource(host as unknown as ComposerHost, () => settings.model, false, registry);
    await source.refresh(() => {});
    expect(values(source, "claude")).toEqual(CLAUDE_MODELS.map((m) => `claude:${m.id}`));
    requestUrlMock.mockRejectedValue(new Error("offline"));
    await registry.refresh();
    expect(registry.models()).toEqual(CLAUDE_MODELS);
    requestUrlMock.mockResolvedValue({ status: 200, json: { unexpected: true }, text: "" });
    await registry.refresh();
    expect(registry.models()).toEqual(CLAUDE_MODELS);
  });

  it("does not request models without a credential or on the Claude Code backend", async () => {
    const none = rig({ apiKey: "" });
    expect(await none.registry.refresh()).toBe(false);
    const cli = rig({ chatBackend: "claude-cli" });
    expect(await cli.registry.refresh()).toBe(false);
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(cli.registry.models()).toEqual(CLAUDE_MODELS);
  });

  it("fetches once per credential and again after the credential changes", async () => {
    requestUrlMock.mockResolvedValue({ status: 200, json: apiResponse, text: "" });
    const { settings, registry } = rig();
    expect(await registry.refresh()).toBe(true);
    expect(await registry.refresh()).toBe(false);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    settings.apiKey = "sk-ant-api-two";
    expect(await registry.refresh()).toBe(true);
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    expect(requestUrlMock.mock.calls[1]![0]).toMatchObject({ method: "GET", url: "https://api.anthropic.com/v1/models?limit=1000", headers: expect.objectContaining({ "x-api-key": "sk-ant-api-two" }) });
    settings.apiKey = "";
    await registry.refresh();
    expect(registry.models()).toEqual(CLAUDE_MODELS);
  });
});
