/** A small compute dispatch in the same Blob worker context used by local models.
 * No model, cache, or network access. Never run automatically during startup. */
declare const GPUBufferUsage: { STORAGE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

export interface GpuReport {
  secureContext: boolean;
  protocol: string;
  webgpu: boolean;
  compute: boolean;
  cacheAvailable?: boolean;
  shaderF16?: boolean;
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
  reason?: string;
}

export async function gpuProbeWorker(): Promise<void> {
  const report: GpuReport = {
    secureContext: self.isSecureContext,
    protocol: self.location.protocol,
    webgpu: typeof navigator.gpu !== "undefined",
    compute: false,
    cacheAvailable: typeof caches !== "undefined",
  };
  let device: GPUDevice | undefined;
  try {
    if (!report.webgpu) throw new Error("Obsidian does not expose WebGPU in this worker.");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No GPU adapter is available in Obsidian.");
    report.shaderF16 = adapter.features.has("shader-f16");
    report.maxBufferSize = adapter.limits.maxBufferSize;
    report.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
    device = await adapter.requestDevice();
    device.pushErrorScope("validation");
    const output = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: "@group(0) @binding(0) var<storage, read_write> value: u32; @compute @workgroup_size(1) fn main() { value = 42u; }" });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const value = new Uint32Array(readback.getMappedRange())[0];
    readback.unmap(); readback.destroy(); output.destroy();
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
    if (value !== 42) throw new Error("GPU compute returned an invalid result.");
    report.compute = true;
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    device?.destroy();
  }
  self.postMessage(report);
}

export function probeDeviceGpu(): Promise<GpuReport> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([`(${gpuProbeWorker.toString()})()`], { type: "text/javascript" }));
    let worker: Worker;
    try { worker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); reject(error instanceof Error ? error : new Error(String(error))); return; }
    const cleanup = (): void => { window.clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("On-device GPU check timed out.")); }, 10_000);
    worker.onmessage = (event: MessageEvent<GpuReport>) => { cleanup(); resolve(event.data); };
    worker.onerror = () => { cleanup(); reject(new Error("Obsidian could not run the GPU worker.")); };
  });
}
