import type { StreamHandlers } from "../types";
import type { DeviceRequest, DeviceWorkerRequest, DeviceWorkerResponse } from "./protocol";

/** One foreground request owns one worker. No retained model allocations,
 * startup inference, concurrent loads, or automatic retries after a failure. */
export class DeviceChatClient {
  private next = 1;
  private active: { cancel: () => void } | undefined;
  constructor(private factory: () => Worker, private beforeRun: () => void = () => {}) {}

  generate(request: DeviceRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<string> {
    return this.run({ type: "device-generate", id: this.next++, request }, handlers, signal);
  }
  async download(modelId: string, onProgress: (percent: number, file: string) => void, signal?: AbortSignal): Promise<void> {
    await this.run({ type: "device-download", id: this.next++, modelId }, { onText: () => {} }, signal, onProgress);
  }
  cancel(): void { this.active?.cancel(); }
  busy(): boolean { return this.active !== undefined; }

  private run(message: DeviceWorkerRequest, handlers: StreamHandlers, signal?: AbortSignal, progress?: (percent: number, file: string) => void): Promise<string> {
    if (this.active) return Promise.reject(new Error("An on-device request is already running. Stop it before starting another."));
    if (signal?.aborted) return Promise.reject(new DOMException("On-device request cancelled.", "AbortError"));
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try { this.beforeRun(); worker = this.factory(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
      let settled = false;
      const finish = (error?: Error, text = ""): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        worker.terminate();
        this.active = undefined;
        if (error) reject(error); else resolve(text);
      };
      const cancel = (): void => finish(new DOMException("On-device request cancelled.", "AbortError"));
      const timer = window.setTimeout(() => finish(new Error("On-device request timed out. Try a shorter passage or the smaller model.")), 300_000);
      this.active = { cancel };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      worker.onerror = () => finish(new Error("The on-device model worker stopped. Try the smaller model; no request was sent to a cloud provider."));
      worker.onmessage = (event: MessageEvent<DeviceWorkerResponse>) => {
        const response = event.data;
        if (settled || response.id !== message.id) return;
        if (response.type === "device-text") {
          try { handlers.onText(response.text); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        }
        else if (response.type === "device-progress") progress?.(response.percent, response.file);
        else if (response.type === "device-error") finish(new Error(response.message));
        else if (response.type === "device-result") {
          if (response.truncated) handlers.onTruncated?.();
          finish(undefined, response.text);
        }
      };
      try { worker.postMessage(message); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
