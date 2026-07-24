import { describe, it, expect } from "vitest";
import { RequestTracker, type WorkerResponse } from "../../src/semantic/transformers/protocol";
import { BUILTIN_EMBEDDING_MODEL } from "../../src/semantic/transformers/model";

describe("BUILTIN_EMBEDDING_MODEL", () => {
  it("pins the arctic-embed-xs default", () => {
    expect(BUILTIN_EMBEDDING_MODEL.id).toBe("builtin:snowflake-arctic-embed-xs");
    expect(BUILTIN_EMBEDDING_MODEL.hfRepo).toBe("Snowflake/snowflake-arctic-embed-xs");
    expect(BUILTIN_EMBEDDING_MODEL.pooling).toBe("cls");
    expect(BUILTIN_EMBEDDING_MODEL.dim).toBe(384);
    expect(BUILTIN_EMBEDDING_MODEL.approxDownloadMB).toBeGreaterThan(0);
  });
});

describe("RequestTracker", () => {
  it("correlates responses to requests by id", async () => {
    const t = new RequestTracker();
    const req = t.create<number[][]>();
    t.settle({ id: req.id, type: "result", vectors: [[1, 2]] } as WorkerResponse);
    await expect(req.promise).resolves.toEqual([[1, 2]]);
  });
  it("rejects on error responses", async () => {
    const t = new RequestTracker();
    const req = t.create<number[][]>();
    t.settle({ id: req.id, type: "error", message: "boom" });
    await expect(req.promise).rejects.toThrow("boom");
  });
  it("routes progress events to the request's onProgress without settling", async () => {
    const t = new RequestTracker();
    const seen: number[] = [];
    const req = t.create<number[][]>((p) => seen.push(p.percent));
    t.settle({ id: req.id, type: "progress", percent: 40, file: "model_quantized.onnx" });
    t.settle({ id: req.id, type: "progress", percent: 90, file: "model_quantized.onnx" });
    t.settle({ id: req.id, type: "result", vectors: [] });
    await req.promise;
    expect(seen).toEqual([40, 90]);
  });
  it("ignores responses for unknown ids", () => {
    const t = new RequestTracker();
    expect(() => t.settle({ id: 999, type: "result", vectors: [] })).not.toThrow();
  });
  it("rejectAll fails every pending request (worker crash path)", async () => {
    const t = new RequestTracker();
    const a = t.create<number[][]>();
    const b = t.create<number[][]>();
    t.rejectAll(new Error("worker died"));
    await expect(a.promise).rejects.toThrow("worker died");
    await expect(b.promise).rejects.toThrow("worker died");
  });
});
