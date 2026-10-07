export interface NativeRequest {
  version: 1;
  id: string;
  createdAt: number;
  expiresAt: number;
  vaultName: string;
  sourcePath: string;
  input: string;
  instruction: string;
}

export const NATIVE_MODEL = { repo: "mlx-community/Qwen3.5-0.8B-4bit", revision: "da28692b5f139cb0ec58a356b437486b7dac7462" } as const;
export const NATIVE_MAX_FILE_BYTES = 32_768;
export const NATIVE_JOB_FOLDER = "native-jobs";
export const validNativeID = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native handoff.");
  return value as Record<string, unknown>;
}

export function nativeRequestURL(requestPath: string, id: string): string {
  if (!validNativeID(id) || requestPath.split("/").some((p) => !p || p === "." || p === "..")
    || /[\\\0]/.test(requestPath) || new TextEncoder().encode(requestPath).length > 2048
    || !requestPath.endsWith(`/plugins/claude-companion/native-jobs/${id}.request.json`)) {
    throw new Error("Invalid native request path.");
  }
  const params = new URLSearchParams({ id, request: requestPath });
  return `cavi-companion://handoff?${params.toString()}`;
}

export function validateNativeRequest(value: unknown, now: number): NativeRequest {
  const v = object(value);
  if (v.version !== 1 || typeof v.id !== "string" || !validNativeID(v.id)
    || typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt) || v.createdAt <= 0 || v.createdAt > now + 120
    || typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt) || v.expiresAt <= now
    || v.expiresAt <= v.createdAt || v.expiresAt - v.createdAt > 3600
    || typeof v.vaultName !== "string" || !v.vaultName || v.vaultName.length > 256
    || typeof v.sourcePath !== "string" || v.sourcePath.length > 1024
    || typeof v.input !== "string" || v.input.length > 12000
    || typeof v.instruction !== "string" || !v.instruction.trim() || v.instruction.length > 1200) {
    throw new Error("Native request is invalid, too large, or expired. Send a shorter selection again.");
  }
  return { version: 1, id: v.id, createdAt: v.createdAt, expiresAt: v.expiresAt,
    vaultName: v.vaultName, sourcePath: v.sourcePath, input: v.input, instruction: v.instruction };
}

export function validateNativeResult(value: unknown, request: NativeRequest, now: number): string {
  validateNativeRequest(request, now);
  const v = object(value);
  if (v.version !== 1 || v.id !== request.id || v.model !== NATIVE_MODEL.repo || v.revision !== NATIVE_MODEL.revision
    || typeof v.output !== "string" || !v.output.trim() || new TextEncoder().encode(v.output).length > 16384
    || typeof v.instruction !== "string" || !v.instruction.trim() || v.instruction.length > 1200) {
    throw new Error("Native result does not match this request or the supported model.");
  }
  return v.output;
}
