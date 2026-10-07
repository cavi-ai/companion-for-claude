import { describe, expect, it, vi } from "vitest";
import { DeviceProvider, prepareDeviceRequest } from "../src/providers/device";
import { DEVICE_MODELS } from "../src/device/models";
import { DeviceChatClient } from "../src/device/client";
import { ProviderRouter } from "../src/providers/router";
import { DEFAULT_SETTINGS } from "../src/types";
import { needsCredentialSetup } from "../src/providers/setupState";

const request = { model: "qwen3-0.6b", system: "Be helpful.", messages: [{ role: "user" as const, content: "Hi" }], maxTokens: 1000 };

describe("in-Obsidian GPU chat", () => {
  it("pins model exports and caps replies independently of cloud settings", () => {
    for (const model of DEVICE_MODELS) expect(model.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(prepareDeviceRequest(request).maxTokens).toBe(256);
    expect(() => prepareDeviceRequest({ ...request, messages: [{ role: "user", content: "x".repeat(16_001) }] })).toThrow("shorter");
    expect(() => prepareDeviceRequest({ ...request, tools: [{ name: "write", description: "", input_schema: {} }] })).toThrow("tools");
    expect(() => prepareDeviceRequest({ ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "data" } }] }] })).toThrow("text");
    expect(() => prepareDeviceRequest({ ...request, model: "floating-repo" })).toThrow("model");
  });

  it("routes device chat without Anthropic credentials or a cloud fallback", () => {
    const provider = new DeviceProvider(null);
    const router = new ProviderRouter({ ...DEFAULT_SETTINGS, apiKey: "", chatBackend: "device" }, undefined, { isMobile: true, deviceProvider: provider });
    expect(router.chatProvider().provider).toBe(provider);
    expect(router.chatCapabilities()).toMatchObject({ local: true, agentActions: false, cli: false });
    expect(needsCredentialSetup({ backend: "device", hasAnthropicCredential: false })).toBe(false);
    return expect(provider.complete(request)).rejects.toThrow("unavailable");
  });

  it("does no startup allocation and terminates on cancellation before another request can run", async () => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
    const factory = vi.fn(() => worker as unknown as Worker);
    const client = new DeviceChatClient(factory);
    expect(factory).not.toHaveBeenCalled();
    const abort = new AbortController();
    const operation = client.generate(prepareDeviceRequest(request), { onText: vi.fn() }, abort.signal);
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.generate(prepareDeviceRequest(request), { onText: vi.fn() })).rejects.toThrow("already running");
    abort.abort();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("streams only the active request and frees the worker after completion", async () => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null, onerror: null };
    const client = new DeviceChatClient(() => worker as unknown as Worker);
    const onText = vi.fn();
    const result = client.generate(prepareDeviceRequest(request), { onText });
    const id = worker.postMessage.mock.calls[0]![0].id;
    worker.onmessage!({ data: { type: "device-text", id: id + 1, text: "stale" } } as MessageEvent);
    worker.onmessage!({ data: { type: "device-text", id, text: "Hello" } } as MessageEvent);
    worker.onmessage!({ data: { type: "device-result", id, text: "Hello", truncated: false } } as MessageEvent);
    expect(await result).toBe("Hello");
    expect(onText).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
