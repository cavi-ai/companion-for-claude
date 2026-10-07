export interface DeviceRequest {
  modelId: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature: number;
}
export type DeviceWorkerRequest =
  | { type: "device-download"; id: number; modelId: string }
  | { type: "device-generate"; id: number; request: DeviceRequest };
export type DeviceWorkerResponse =
  | { type: "device-text"; id: number; text: string }
  | { type: "device-progress"; id: number; percent: number; file: string }
  | { type: "device-result"; id: number; text: string; truncated: boolean }
  | { type: "device-error"; id: number; message: string };
