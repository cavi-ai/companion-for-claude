import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticController, type SemanticControllerDeps } from "../src/semantic/controller";
import { DEFAULT_SETTINGS } from "../src/types";
import type { WorkerLike } from "../src/semantic/transformers/embedder";
import type { WorkerRequest } from "../src/semantic/transformers/protocol";

const workerFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/semantic/transformers/workerSource", () => ({ createEmbedWorker: workerFactory }));

describe("embedding backend wiring", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([[true, "wasm"], [false, "auto"]] as const)("selects %s mobile → %s for each worker load", async (isMobile, device) => {
    const sent: WorkerRequest[] = [];
    workerFactory.mockImplementation(() => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        terminate: vi.fn(),
        postMessage: (raw) => {
          const message = raw as WorkerRequest;
          sent.push(message);
          queueMicrotask(() => worker.onmessage?.({ data: { id: message.id, type: "result", vectors: [], backend: "wasm" } }));
        },
      };
      return worker;
    });
    const controller = new SemanticController({
      settings: () => ({ ...DEFAULT_SETTINGS, semanticEnabled: true }), isMobile,
    } as SemanticControllerDeps);
    try {
      await controller.builtinEmbedder().download();
      controller.builtinEmbedder().terminate();
      await controller.builtinEmbedder().download();
      expect(sent).toHaveLength(2);
      for (const message of sent) expect(message).toMatchObject({ type: "load", device });
    } finally {
      controller.destroy();
    }
  });
});
