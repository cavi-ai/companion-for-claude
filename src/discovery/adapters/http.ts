import type { DiscoveryAdapterId } from "../types";

export interface DiscoveryHttpRequest {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DiscoveryHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type DiscoveryHttp = (request: DiscoveryHttpRequest) => Promise<DiscoveryHttpResponse>;

export type DiscoveryAdapterErrorCategory = "rate-limit" | "http" | "malformed-response";

export class DiscoveryAdapterError extends Error {
  readonly adapter: DiscoveryAdapterId;
  readonly category: DiscoveryAdapterErrorCategory;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    adapter: DiscoveryAdapterId;
    category: DiscoveryAdapterErrorCategory;
    status?: number;
    retryAfterSeconds?: number;
  }) {
    super(`${input.adapter} adapter ${input.category}`);
    this.name = "DiscoveryAdapterError";
    this.adapter = input.adapter;
    this.category = input.category;
    if (input.status !== undefined) this.status = input.status;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function retryAfterSeconds(headers: Record<string, string>): number | undefined {
  const value = header(headers, "retry-after");
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export function assertSuccessful(adapter: DiscoveryAdapterId, response: DiscoveryHttpResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  const retry = response.status === 429 ? retryAfterSeconds(response.headers) : undefined;
  throw new DiscoveryAdapterError({
    adapter,
    category: response.status === 429 ? "rate-limit" : "http",
    status: response.status,
    ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
  });
}

export function parseJson(adapter: DiscoveryAdapterId, body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DiscoveryAdapterError({ adapter, category: "malformed-response" });
  }
}
