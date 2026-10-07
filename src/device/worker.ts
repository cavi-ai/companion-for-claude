import { pipeline, TextStreamer, env, type Tensor } from "@huggingface/transformers";
import { DEVICE_MAX_INPUT_TOKENS, DEVICE_MAX_OUTPUT_TOKENS, DEVICE_MAX_INPUT_CHARS, deviceModel, deviceModelCached } from "./models";
import type { DeviceWorkerRequest, DeviceWorkerResponse } from "./protocol";

/** Called only in a dedicated foreground worker, never on Obsidian's UI thread.
 * The containing embedding-worker bundle supplies the guarded fetch/env. */
export async function handleDeviceRequest(message: DeviceWorkerRequest, post: (response: DeviceWorkerResponse) => void, setNetwork: (allowed: boolean) => void, checkAsset: (url: string) => Promise<unknown>): Promise<void> {
  const downloading = message.type === "device-download";
  const model = deviceModel(downloading ? message.modelId : message.request.modelId);
  const adapter = typeof navigator.gpu === "undefined" ? null : await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU is unavailable inside Obsidian. This model needs GPU support in the app's WebView.");
  if (!adapter.features.has("shader-f16")) throw new Error("This GPU does not support float16 inference.");
  if (typeof caches === "undefined") throw new Error("Obsidian does not expose a persistent model cache on this device.");
  if (!downloading && !(await deviceModelCached(model.id, caches))) throw new Error("Download the on-device model in Companion settings before chatting. Missing assets will not download automatically.");
  setNetwork(downloading);
  if (!downloading) {
    // ORT's module import can bypass fetch: require cached factories first.
    const paths = (env.backends.onnx as { wasm?: { wasmPaths?: { wasm?: string; mjs?: string } } }).wasm?.wasmPaths;
    for (const url of [paths?.wasm, paths?.mjs]) if (url && !url.startsWith("blob:")) await checkAsset(url);
  }
  const generator = await pipeline("text-generation", model.repo, {
    device: "webgpu", dtype: "q4f16", revision: model.revision,
    progress_callback: (event: unknown) => {
      const info = event as { progress?: number; file?: string };
      if (typeof info.progress === "number") post({ type: "device-progress", id: message.id, percent: Math.round(info.progress), file: info.file ?? "" });
    },
  });
  let text = "";
  let truncated = false;
  try {
    if (!downloading) {
      const request = message.request;
      if (request.messages.length > 33 || request.messages.reduce((n, m) => n + m.content.length, 0) > DEVICE_MAX_INPUT_CHARS) throw new Error("Use a shorter passage or a new chat for the on-device model.");
      const templateOptions = { tokenize: false as const, add_generation_prompt: true, enable_thinking: false };
      const prompt = generator.tokenizer.apply_chat_template(request.messages, templateOptions);
      const inputs = generator.tokenizer(prompt, { truncation: false, add_special_tokens: false });
      const inputTokens = inputs.input_ids.dims.at(-1) ?? 0;
      if (inputTokens > DEVICE_MAX_INPUT_TOKENS) throw new Error(`On-device context exceeds ${DEVICE_MAX_INPUT_TOKENS} tokens. Use a shorter passage, fewer notes, or a new chat.`);
      const streamer = new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (delta: string) => {
        text += delta;
        post({ type: "device-text", id: message.id, text: delta });
      } });
      const maxTokens = Math.min(request.maxTokens, DEVICE_MAX_OUTPUT_TOKENS);
      const output = await generator.model.generate({ ...inputs, max_new_tokens: maxTokens, do_sample: request.temperature > 0,
        ...(request.temperature > 0 ? { temperature: request.temperature, top_p: 0.9 } : {}), return_dict_in_generate: false, streamer }) as Tensor;
      const generated = (output.dims.at(-1) ?? inputTokens) - inputTokens;
      if (!text.trim()) throw new Error("The on-device model returned no text. Try a simpler request.");
      truncated = generated >= maxTokens;
    }
  } finally {
    try { await generator.dispose(); } finally { setNetwork(false); }
  }
  post({ type: "device-result", id: message.id, text, truncated });
}
