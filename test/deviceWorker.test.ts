import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), env: { backends: { onnx: { wasm: { wasmPaths: { wasm: "https://runtime/ort.wasm", mjs: "https://runtime/ort.mjs" } } } } } }));
vi.mock("@huggingface/transformers", () => ({
  ...mocks,
  TextStreamer: class { constructor(_tokenizer: unknown, public options: { callback_function: (text: string) => void }) {} },
}));
import { handleDeviceRequest } from "../src/device/worker";
import { deviceModelCached, DEVICE_MODELS, DEVICE_ASSETS, deviceAssetURL } from "../src/device/models";
import type { DeviceWorkerRequest } from "../src/device/protocol";
import { prepareDeviceRequest } from "../src/providers/device";

const generation: DeviceWorkerRequest = { id: 1, type: "device-generate", request: prepareDeviceRequest({ model: "qwen3-0.6b", system: "Be helpful", messages: [{ role: "user", content: "Hi" }], maxTokens: 256 }) };
const post = vi.fn(), network = vi.fn(), check = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) } });
  vi.stubGlobal("caches", { open: async () => ({ match: async () => ({}) }) });
});
afterEach(() => vi.unstubAllGlobals());

function generator(tokens = 12) {
  const tokenizer = Object.assign(() => ({ input_ids: { dims: [1, tokens] } }), { apply_chat_template: vi.fn(() => "prompt") });
  const generate = vi.fn(async (options: { streamer: { options: { callback_function: (delta: string) => void } } }) => {
    options.streamer.options.callback_function("Hello");
    return { dims: [1, tokens + 1] };
  });
  const g = { tokenizer, model: { generate }, dispose: vi.fn() };
  mocks.pipeline.mockResolvedValue(g);
  return g;
}

describe("device worker boundaries", () => {
  it("refuses unsupported GPU and absent cache without loading a model", async () => {
    vi.stubGlobal("navigator", {});
    await expect(handleDeviceRequest(generation, post, network, check)).rejects.toThrow("WebGPU");
    expect(mocks.pipeline).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) } });
    vi.stubGlobal("caches", { open: async () => ({ match: async () => undefined }) });
    await expect(handleDeviceRequest(generation, post, network, check)).rejects.toThrow("Download");
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it("requires pinned assets rather than floating or partial cache entries", async () => {
    const model = DEVICE_MODELS[0];
    const files = new Map(DEVICE_ASSETS.map((file) => [deviceAssetURL(model, file), {}]));
    const storage = { open: async () => ({ match: async (url: string) => files.get(url) }) } as unknown as CacheStorage;
    expect(await deviceModelCached(model.id, storage)).toBe(true);
    files.delete(deviceAssetURL(model, "onnx/model_q4f16.onnx"));
    files.set(deviceAssetURL(model, "onnx/model_q4f16.onnx").replace(model.revision, "main"), {});
    expect(await deviceModelCached(model.id, storage)).toBe(false);
  });

  it("downloads only on explicit request and never generates during download", async () => {
    const g = generator();
    await handleDeviceRequest({ type: "device-download", id: 1, modelId: "qwen3-0.6b" }, post, network, check);
    expect(network.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(g.model.generate).not.toHaveBeenCalled();
    expect(mocks.pipeline).toHaveBeenCalledWith("text-generation", DEVICE_MODELS[0].repo, expect.objectContaining({ device: "webgpu", dtype: "q4f16", revision: DEVICE_MODELS[0].revision }));
    expect(g.dispose).toHaveBeenCalledOnce();
  });

  it("uses cached runtime files, disables thinking, streams text, and releases sessions", async () => {
    const g = generator();
    await handleDeviceRequest(generation, post, network, check);
    expect(check).toHaveBeenCalledTimes(2);
    expect(network).not.toHaveBeenCalledWith(true);
    expect(g.tokenizer.apply_chat_template).toHaveBeenCalledWith(generation.request.messages, expect.objectContaining({ enable_thinking: false }));
    expect(post).toHaveBeenCalledWith({ type: "device-text", id: 1, text: "Hello" });
    expect(post).toHaveBeenCalledWith({ type: "device-result", id: 1, text: "Hello", truncated: false });
    expect(g.dispose).toHaveBeenCalledOnce();
  });

  it("rejects oversized tokenized context before allocating generation tensors", async () => {
    const g = generator(2049);
    await expect(handleDeviceRequest(generation, post, network, check)).rejects.toThrow("2048");
    expect(g.model.generate).not.toHaveBeenCalled();
    expect(g.dispose).toHaveBeenCalledOnce();
  });

  it("does not retry a failing WebGPU session on WASM", async () => {
    mocks.pipeline.mockRejectedValue(new Error("GPU device lost"));
    await expect(handleDeviceRequest(generation, post, network, check)).rejects.toThrow("GPU device lost");
    expect(mocks.pipeline).toHaveBeenCalledOnce();
  });

  it("does not report success before cleanup, even when disposal fails", async () => {
    const g = generator();
    g.dispose.mockRejectedValue(new Error("GPU disposal failed"));
    await expect(handleDeviceRequest({ type: "device-download", id: 1, modelId: "qwen3-0.6b" }, post, network, check)).rejects.toThrow("GPU disposal failed");
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "device-result" }));
    expect(network).toHaveBeenLastCalledWith(false);
  });
});
