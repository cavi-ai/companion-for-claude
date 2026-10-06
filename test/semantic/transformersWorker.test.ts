import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "../../src/semantic/transformers/protocol";

const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {
    allowLocalModels: true,
    useBrowserCache: false,
    useWasmCache: false,
    backends: { onnx: { wasm: { numThreads: 4 } } },
  },
}));

vi.mock("@huggingface/transformers", () => transformers);

describe("built-in embedding worker", () => {
  it("bounds tokenizer context before GPU warm-up and fallback inference", async () => {
    const observed: number[] = [];
    transformers.pipeline.mockImplementation(async (_task, _repo, options) => {
      const tokenizer = { config: { model_max_length: 8192 } };
      return Object.assign(async () => {
        observed.push(tokenizer.config.model_max_length);
        if (options.device === "webgpu") throw new Error("GPU warm-up failed");
        return { tolist: () => [[1, 0]] };
      }, { tokenizer, dispose: async () => undefined });
    });
    const responses: WorkerResponse[] = [];
    const scope = { onmessage: null as ((e: { data: WorkerRequest }) => void) | null, postMessage: (m: WorkerResponse) => responses.push(m) };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    await import("../../src/semantic/transformers/worker");
    scope.onmessage?.({ data: { id: 1, type: "load", repo: "test", revision: "pinned", dtype: "q8", maxTokens: 512, dim: 2, pooling: "cls" } });
    await vi.waitFor(() => expect(responses.at(-1)?.type).toBe("result"));
    scope.onmessage?.({ data: { id: 2, type: "embed", texts: ["long input"] } });
    await vi.waitFor(() => expect(responses).toContainEqual({ id: 2, type: "result", vectors: [[1, 0]] }));
    expect(observed).toEqual([512, 512]);
    // A corrupt or unexpected model output must never enter the persisted index.
    scope.onmessage?.({ data: { id: 3, type: "embed", texts: ["one", "two"] } });
    await vi.waitFor(() => expect(responses).toContainEqual({ id: 3, type: "error", message: "Embedding output does not match the selected model's dimensions" }));
  });

  it("refuses uncached assets without fetching until an explicit download request", async () => {
    const network = vi.fn(async () => new Response("download"));
    vi.stubGlobal("fetch", network);
    vi.stubGlobal("caches", { open: async () => ({ match: async () => undefined }) });
    transformers.pipeline.mockImplementation(async () => { await globalThis.fetch("https://huggingface.co/missing/model.onnx"); return Object.assign(async () => ({ tolist: () => [] }), { tokenizer: { config: { model_max_length: 8192 } } }); });
    const responses: WorkerResponse[] = [];
    const scope = { onmessage: null as ((e: { data: WorkerRequest }) => void) | null, postMessage: (m: WorkerResponse) => responses.push(m) };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("navigator", {});
    await import("../../src/semantic/transformers/worker");
    scope.onmessage?.({ data: { id: 1, type: "load", repo: "test", revision: "d8c86521100d3556476a063fc2342036d45c106f", dtype: "q8", maxTokens: 512, dim: 2, pooling: "cls" } });
    await vi.waitFor(() => expect(responses[0]?.type).toBe("error"));
    expect(network).not.toHaveBeenCalled();
    scope.onmessage?.({ data: { id: 2, type: "load", repo: "test", revision: "d8c86521100d3556476a063fc2342036d45c106f", dtype: "q8", maxTokens: 512, dim: 2, pooling: "cls", allowDownload: true } });
    await vi.waitFor(() => expect(responses.at(-1)?.type).toBe("result"));
    expect(network).toHaveBeenCalledTimes(1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("uses WASM directly when the WebGPU API has no adapter", async () => {
    let runtimePoisoned = false;
    transformers.pipeline.mockImplementation(async (_task, _repo, options) => {
      if (options.device === "webgpu") {
        runtimePoisoned = true;
        throw new Error("Failed to get GPU adapter");
      }
      if (runtimePoisoned) throw new Error("WebGPU initialization poisoned the shared runtime");
      return Object.assign(
        async () => ({ tolist: () => [] }),
        { tokenizer: { config: { model_max_length: 8192 } }, dispose: async () => undefined },
      );
    });

    const responses: WorkerResponse[] = [];
    const workerScope: {
      onmessage: ((event: { data: WorkerRequest }) => void) | null;
      postMessage(message: WorkerResponse): void;
    } = {
      onmessage: null,
      postMessage: (message) => responses.push(message),
    };
    vi.stubGlobal("self", workerScope);
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: async () => null },
    });

    await import("../../src/semantic/transformers/worker");
    workerScope.onmessage?.({
      data: {
        id: 1,
        type: "load",
        repo: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f", dtype: "q8", maxTokens: 512, dim: 2, pooling: "cls",
      },
    });

    await vi.waitFor(() => {
      expect(responses).toContainEqual({ id: 1, type: "result", vectors: [], backend: "wasm" });
    });
    expect(transformers.pipeline).toHaveBeenCalledWith("feature-extraction", "Snowflake/snowflake-arctic-embed-xs", expect.objectContaining({ revision: "d8c86521100d3556476a063fc2342036d45c106f", dtype: "q8" }));
  });

  it("disposes a failed WebGPU session before constructing the WASM fallback", async () => {
    let finishDispose!: () => void;
    const disposePending = new Promise<void>((resolve) => { finishDispose = resolve; });
    let disposeStarted = false;
    transformers.pipeline.mockImplementation(async (_task, _repo, options) => {
      if (options.device === "webgpu") {
        return Object.assign(
          async () => { throw new Error("WebGPU warm-up failed"); },
          {
            tokenizer: { config: { model_max_length: 8192 } },
            dispose: async () => {
              disposeStarted = true;
              await disposePending;
            },
          },
        );
      }
      return Object.assign(
        async () => ({ tolist: () => [] }),
        { tokenizer: { config: { model_max_length: 8192 } }, dispose: async () => undefined },
      );
    });

    const responses: WorkerResponse[] = [];
    const workerScope: {
      onmessage: ((event: { data: WorkerRequest }) => void) | null;
      postMessage(message: WorkerResponse): void;
    } = {
      onmessage: null,
      postMessage: (message) => responses.push(message),
    };
    vi.stubGlobal("self", workerScope);
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: async () => ({}) },
    });

    await import("../../src/semantic/transformers/worker");
    workerScope.onmessage?.({
      data: {
        id: 1,
        type: "load",
        repo: "Snowflake/snowflake-arctic-embed-xs",
        revision: "d8c86521100d3556476a063fc2342036d45c106f", dtype: "q8", maxTokens: 512, dim: 2, pooling: "cls",
      },
    });

    await vi.waitFor(() => expect(disposeStarted).toBe(true));
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
    finishDispose();
    await vi.waitFor(() => {
      expect(responses).toContainEqual({ id: 1, type: "result", vectors: [], backend: "wasm" });
    });
    expect(transformers.pipeline.mock.calls.map((call) => call[2].device)).toEqual(["webgpu", "wasm"]);
  });

  it("disposes a lost WebGPU session before rebuilding on WASM", async () => {
    let finishDispose!: () => void;
    const disposePending = new Promise<void>((resolve) => { finishDispose = resolve; });
    let disposeStarted = false;
    let webgpuCalls = 0;
    transformers.pipeline.mockImplementation(async (_task, _repo, options) => {
      if (options.device === "webgpu") {
        return Object.assign(
          async () => {
            webgpuCalls++;
            if (webgpuCalls === 1) return { tolist: () => [] };
            throw new Error("WebGPU device lost");
          },
          {
            tokenizer: { config: { model_max_length: 8192 } },
            dispose: async () => {
              disposeStarted = true;
              await disposePending;
            },
          },
        );
      }
      return Object.assign(
        async () => ({ tolist: () => [[1]] }),
        { tokenizer: { config: { model_max_length: 8192 } }, dispose: async () => undefined },
      );
    });

    const responses: WorkerResponse[] = [];
    const workerScope: {
      onmessage: ((event: { data: WorkerRequest }) => void) | null;
      postMessage(message: WorkerResponse): void;
    } = {
      onmessage: null,
      postMessage: (message) => responses.push(message),
    };
    vi.stubGlobal("self", workerScope);
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });

    await import("../../src/semantic/transformers/worker");
    workerScope.onmessage?.({ data: { id: 1, type: "load", repo: "Snowflake/snowflake-arctic-embed-xs", revision: "d8c86521100d3556476a063fc2342036d45c106f", dtype: "q8", maxTokens: 512, dim: 1, pooling: "cls" } });
    await vi.waitFor(() => expect(responses).toContainEqual({ id: 1, type: "result", vectors: [], backend: "webgpu" }));
    workerScope.onmessage?.({ data: { id: 2, type: "embed", texts: ["probe"] } });

    await vi.waitFor(() => expect(disposeStarted).toBe(true));
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
    finishDispose();
    await vi.waitFor(() => expect(responses).toContainEqual({ id: 2, type: "result", vectors: [[1]] }));
    expect(transformers.pipeline.mock.calls.map((call) => call[2].device)).toEqual(["webgpu", "wasm"]);
  });
});
