import { expect, test } from "vitest";
import { startProviderStub, freshStubState } from "../../e2e/rig/stubs";
test("provider stub answers preflight and streams with CORS", async () => {
  const state = freshStubState();
  const { server, port } = await startProviderStub(state);
  try {
    const pre = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-api-key,anthropic-version,content-type", Origin: "app://obsidian.md" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toBe("x-api-key,anthropic-version,content-type");
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: JSON.stringify({ stream: true }), headers: { Origin: "app://obsidian.md" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toContain("content_block_delta");
    expect(state.requests).toBe(1);
  } finally { server.close(); }
});
