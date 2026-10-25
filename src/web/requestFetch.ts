// The fetch API over Obsidian's requestUrl, for libraries that take a fetch
// option, and the web-capture IO built on it. requestUrl is not bound by the
// app origin's CORS rules. IO injected.

import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { WebCaptureIo } from "../research/webCapture";

/** A fetch that sends through `request`; an aborted signal rejects even while the request is in flight. */
export function requestUrlFetch(request: (param: RequestUrlParam) => Promise<RequestUrlResponse>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === "string" ? init.body : undefined;
    const sent = request({ url, method: init?.method ?? "GET", headers, ...(body !== undefined ? { body } : {}), throw: false });
    const response = await (signal
      ? Promise.race([sent, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true }))])
      : sent);
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : response.arrayBuffer, { status: response.status, headers: response.headers });
  };
}

/** Web-capture IO over `request`: page HTML, DOM parsing, markdown conversion, and fetch for an extractor's own requests. */
export function requestUrlCaptureIo(
  request: (param: RequestUrlParam) => Promise<RequestUrlResponse>,
  toMarkdown: (html: string) => string,
): Required<WebCaptureIo> {
  return {
    fetchHtml: async (url) => {
      const response = await request({ url, method: "GET", throw: false });
      if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
      return response.text;
    },
    parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
    toMarkdown,
    fetch: requestUrlFetch(request),
  };
}
