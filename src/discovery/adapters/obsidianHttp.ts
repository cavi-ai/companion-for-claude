import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { DiscoveryHttp } from "./http";

type Request = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

const aborted = (): DOMException => new DOMException("Discovery request canceled", "AbortError");

/**
 * Obsidian's requestUrl avoids webview CORS restrictions but cannot abort an
 * in-flight request. We gate before dispatch and discard its response if the
 * caller cancels while it is pending.
 */
export function createObsidianDiscoveryHttp(request: Request = requestUrl): DiscoveryHttp {
  return async ({ url, headers, signal }) => {
    if (signal?.aborted) throw aborted();
    const response = await request({ url, method: "GET", ...(headers ? { headers } : {}), throw: false });
    if (signal?.aborted) throw aborted();
    return { status: response.status, headers: { ...response.headers }, body: response.text };
  };
}
