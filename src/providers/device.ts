import type { StreamHandlers } from "../types";
import { DEVICE_MAX_INPUT_CHARS, DEVICE_MAX_OUTPUT_TOKENS, deviceModel } from "../device/models";
import type { DeviceChatClient } from "../device/client";
import type { DeviceRequest } from "../device/protocol";
import { probeDeviceGpu } from "../device/gpu";
import type { CompletionRequest, Provider, ProviderStatus } from "./types";

export function prepareDeviceRequest(request: CompletionRequest): DeviceRequest {
  deviceModel(request.model);
  if (request.tools?.length) throw new Error("On-device chat does not support agent tools. Turn off agent mode.");
  if (!Number.isFinite(request.maxTokens) || request.maxTokens < 1) throw new Error("Choose a positive response token limit.");
  const messages: DeviceRequest["messages"] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (typeof message.content !== "string" && message.content.some((b) => b.type !== "text")) throw new Error("On-device chat supports text only. Remove media or tool messages.");
    messages.push({ role: message.role, content: typeof message.content === "string" ? message.content : message.content.map((b) => (b as { text: string }).text).join("\n") });
  }
  if (messages.length > 33 || messages.reduce((n, m) => n + m.content.length, 0) > DEVICE_MAX_INPUT_CHARS) throw new Error("Use a shorter passage, fewer attached notes, or a new chat for the on-device model.");
  return { modelId: request.model, messages, maxTokens: Math.min(request.maxTokens, DEVICE_MAX_OUTPUT_TOKENS), temperature: Math.max(0, Math.min(request.temperature ?? 0.7, 2)) };
}

export class DeviceProvider implements Provider {
  readonly id = "device" as const;
  readonly label = "On-device GPU";
  readonly supportsTools = false;
  constructor(private client: DeviceChatClient | null) {}
  hasCredentials(): boolean { return this.client !== null; }
  async capabilities(): Promise<readonly string[]> { return []; }
  async stream(request: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    if (!this.client) throw new Error("On-device inference is unavailable in this runtime.");
    const text = await this.client.generate(prepareDeviceRequest(request), handlers, request.signal);
    handlers.onDone?.(text);
  }
  async complete(request: CompletionRequest): Promise<string> {
    if (!this.client) throw new Error("On-device inference is unavailable in this runtime.");
    return this.client.generate(prepareDeviceRequest(request), { onText: () => {} }, request.signal);
  }
  async test(): Promise<ProviderStatus> {
    try {
      const report = await probeDeviceGpu();
      return { ok: report.compute && report.shaderF16 === true, detail: report.compute && report.shaderF16 ? "GPU compute and float16 work inside Obsidian." : report.reason ?? "This GPU does not support float16 inference." };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  }
}
