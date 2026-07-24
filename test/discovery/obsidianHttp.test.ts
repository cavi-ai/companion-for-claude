import { describe, expect, it, vi } from "vitest";
import { createObsidianDiscoveryHttp } from "../../src/discovery/adapters/obsidianHttp";

describe("Obsidian discovery HTTP transport", () => {
  it("maps only status, headers, and text through requestUrl", async () => {
    const request = vi.fn(async () => ({
      status: 206,
      headers: { "content-type": "application/json" },
      text: "raw response",
      json: { secret: true },
      arrayBuffer: new ArrayBuffer(1),
    }));
    const http = createObsidianDiscoveryHttp(request as never);

    await expect(http({ url: "https://example.test/work", headers: { Accept: "application/json" } })).resolves.toEqual({
      status: 206,
      headers: { "content-type": "application/json" },
      body: "raw response",
    });
    expect(request).toHaveBeenCalledWith({
      url: "https://example.test/work",
      method: "GET",
      headers: { Accept: "application/json" },
      throw: false,
    });
  });

  it("does not start an already-cancelled request and safely discards an in-flight response", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    const http = createObsidianDiscoveryHttp(request as never);
    await expect(http({ url: "https://example.test", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();

    let release!: (value: { status: number; headers: Record<string, string>; text: string }) => void;
    const pendingRequest = vi.fn(() => new Promise<{ status: number; headers: Record<string, string>; text: string }>((resolve) => { release = resolve; }));
    const pendingHttp = createObsidianDiscoveryHttp(pendingRequest as never);
    const second = new AbortController();
    const result = pendingHttp({ url: "https://example.test", signal: second.signal });
    second.abort();
    release({ status: 200, headers: {}, text: "must be discarded" });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
