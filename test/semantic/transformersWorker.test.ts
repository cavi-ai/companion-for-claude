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
        { dispose: async () => undefined },
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
        pooling: "cls",
      },
    });

    await vi.waitFor(() => {
      expect(responses).toContainEqual({ id: 1, type: "result", vectors: [], backend: "wasm" });
    });
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
            dispose: async () => {
              disposeStarted = true;
              await disposePending;
            },
          },
        );
      }
      return Object.assign(
        async () => ({ tolist: () => [] }),
        { dispose: async () => undefined },
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
        pooling: "cls",
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
            dispose: async () => {
              disposeStarted = true;
              await disposePending;
            },
          },
        );
      }
      return Object.assign(
        async () => ({ tolist: () => [[1]] }),
        { dispose: async () => undefined },
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
    workerScope.onmessage?.({ data: { id: 1, type: "load", repo: "Snowflake/snowflake-arctic-embed-xs", pooling: "cls" } });
    await vi.waitFor(() => expect(responses).toContainEqual({ id: 1, type: "result", vectors: [], backend: "webgpu" }));
    workerScope.onmessage?.({ data: { id: 2, type: "embed", texts: ["probe"] } });

    await vi.waitFor(() => expect(disposeStarted).toBe(true));
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
    finishDispose();
    await vi.waitFor(() => expect(responses).toContainEqual({ id: 2, type: "result", vectors: [[1]] }));
    expect(transformers.pipeline.mock.calls.map((call) => call[2].device)).toEqual(["webgpu", "wasm"]);
  });
});
