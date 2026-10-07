import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type Plugin } from "obsidian";
import { gpuProbeWorker, type GpuReport } from "../src/device/gpu";
import { registerDeviceGpuCheck } from "../src/device/controller";

afterEach(() => vi.unstubAllGlobals());

describe("GPU capability inside Obsidian's worker", () => {
  it("fails closed when the host does not expose WebGPU", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("self", { isSecureContext: false, location: { protocol: "blob:" }, postMessage });
    vi.stubGlobal("navigator", {});
    await gpuProbeWorker();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ webgpu: false, compute: false, secureContext: false }));
  });

  it("requires a real adapter instead of equating an API property with working compute", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("self", { isSecureContext: true, location: { protocol: "blob:" }, postMessage });
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
    await gpuProbeWorker();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ webgpu: true, compute: false, reason: "No GPU adapter is available in Obsidian." }));
  });

  it.each([42, 0])("validates compute output (%s) and releases the GPU device", async (value) => {
    const postMessage = vi.fn();
    const destroy = vi.fn();
    const buffer = { mapAsync: vi.fn(), getMappedRange: () => new Uint32Array([value]).buffer, unmap: vi.fn(), destroy: vi.fn() };
    const encoder = { beginComputePass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() }), copyBufferToBuffer: vi.fn(), finish: vi.fn() };
    const device = { pushErrorScope: vi.fn(), popErrorScope: async () => null, createBuffer: () => buffer, createShaderModule: vi.fn(), createComputePipelineAsync: async () => ({ getBindGroupLayout: vi.fn() }), createBindGroup: vi.fn(), createCommandEncoder: () => encoder, queue: { submit: vi.fn() }, destroy };
    vi.stubGlobal("self", { isSecureContext: true, location: { protocol: "blob:" }, postMessage });
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]), limits: { maxBufferSize: 256_000_000, maxStorageBufferBindingSize: 128_000_000 }, requestDevice: async () => device }) } });
    await gpuProbeWorker();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ compute: value === 42, shaderF16: true }));
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does no startup work, coalesces checks, and persists no vault content", async () => {
    const app = new App();
    const write = vi.fn();
    Object.assign(app.vault, { configDir: ".obsidian", adapter: { write } });
    const commands: { callback: () => void }[] = [];
    const plugin = { app, manifest: { id: "claude-companion", version: "0.41.1" }, addCommand: (c: { callback: () => void }) => commands.push(c), registerObsidianProtocolHandler: vi.fn() } as unknown as Plugin;
    let resolve!: (report: GpuReport) => void;
    const probe = vi.fn(() => new Promise<GpuReport>((r) => { resolve = r; }));
    registerDeviceGpuCheck(plugin, probe);
    expect(probe).not.toHaveBeenCalled();
    commands[0]!.callback(); commands[0]!.callback();
    expect(probe).toHaveBeenCalledOnce();
    resolve({ secureContext: true, protocol: "blob:", webgpu: true, compute: true });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.calls[0]![0]).toBe(".obsidian/plugins/claude-companion/on-device-gpu.json");
  });
});
