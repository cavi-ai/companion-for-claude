/** Immutable ONNX exports. Weight bytes are download sizes, not peak RAM. */
export const DEVICE_MODELS = [
  { id: "qwen3-0.6b", name: "Qwen3 0.6B", label: "Qwen3 0.6B · 579 MB", repo: "onnx-community/Qwen3-0.6B-ONNX", revision: "da1453100cf3ff33ef56d17983fc7a8648706db6", weightBytes: 569_789_750 },
  { id: "smollm2-360m", name: "SmolLM2 360M", label: "SmolLM2 360M · 275 MB · smaller", repo: "HuggingFaceTB/SmolLM2-360M-Instruct", revision: "a10cc1512eabd3dde888204e902eca88bddb4951", weightBytes: 272_737_275 },
] as const;
export type DeviceModel = typeof DEVICE_MODELS[number];
export const DEFAULT_DEVICE_MODEL = DEVICE_MODELS[1].id;
export const DEVICE_MAX_INPUT_TOKENS = 2048;
export const DEVICE_MAX_OUTPUT_TOKENS = 256;
export const DEVICE_MAX_INPUT_CHARS = 16_000;
export const DEVICE_CACHE = "transformers-cache";
export const DEVICE_ASSETS = ["config.json", "tokenizer.json", "tokenizer_config.json", "generation_config.json", "onnx/model_q4f16.onnx"] as const;

export function deviceModel(id: string): DeviceModel {
  const model = DEVICE_MODELS.find((m) => m.id === id);
  if (!model) throw new Error("Choose a supported on-device model in Companion settings.");
  return model;
}

export function deviceAssetURL(model: DeviceModel, file: string): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
}

export async function deviceModelCached(id: string, storage: CacheStorage | undefined): Promise<boolean> {
  if (!storage) return false;
  try {
    const model = deviceModel(id);
    const cache = await storage.open(DEVICE_CACHE);
    return (await Promise.all(DEVICE_ASSETS.map((file) => cache.match(deviceAssetURL(model, file))))).every(Boolean);
  } catch { return false; }
}

export async function clearDeviceModel(id: string, storage: CacheStorage | undefined): Promise<void> {
  if (!storage) return;
  const model = deviceModel(id);
  const prefix = deviceAssetURL(model, "");
  const cache = await storage.open(DEVICE_CACHE);
  for (const key of await cache.keys()) if (key.url.startsWith(prefix)) await cache.delete(key);
}
