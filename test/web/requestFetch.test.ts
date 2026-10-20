import { describe, expect, it, vi } from "vitest";
import { requestUrlFetch } from "../../src/web/requestFetch";
import { fetchVideoTranscript } from "../../src/living/youtube";

const reply = (status: number, text: string) => ({ status, text, headers: { "content-type": "application/json" }, arrayBuffer: new TextEncoder().encode(text).buffer, json: null });

describe("requestUrlFetch", () => {
  it("sends the method, headers and body through requestUrl and returns its reply as a Response", async () => {
    const request = vi.fn(async () => reply(200, '{"ok":true}'));
    const response = await requestUrlFetch(request as never)(new URL("https://www.youtube.com/youtubei/v1/player"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "test" },
      body: "{}",
    });
    expect(request).toHaveBeenCalledWith({
      url: "https://www.youtube.com/youtubei/v1/player",
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "test" },
      body: "{}",
      throw: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("keeps error statuses, empties a 204, and rejects when the signal aborts", async () => {
    expect((await requestUrlFetch(async () => reply(404, "missing") as never)("https://x.test")).status).toBe(404);
    expect(await (await requestUrlFetch(async () => reply(204, "") as never)("https://x.test")).text()).toBe("");
    const controller = new AbortController();
    const pending = requestUrlFetch(() => new Promise(() => undefined))("https://x.test", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("fetchVideoTranscript", () => {
  it("fetches nothing for a URL that is not a YouTube video", async () => {
    const fetchHtml = vi.fn(async () => "<html></html>");
    expect(await fetchVideoTranscript("https://vimeo.com/12345", { fetchHtml, parseHtml: vi.fn(), fetch: vi.fn() })).toBeNull();
    expect(await fetchVideoTranscript("javascript:alert(1)", { fetchHtml, parseHtml: vi.fn(), fetch: vi.fn() })).toBeNull();
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});
