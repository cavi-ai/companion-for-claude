import { expect, test } from "vitest";
import { startProviderStub, freshStubState } from "../../e2e/rig/stubs";

test("provider stub serves the model list without counting it or spending a reply", async () => {
  const state = freshStubState();
  state.replyRules = [{ match: "/./", replies: ["first", "second"] }];
  const { server, port } = await startProviderStub(state);
  try {
    const models = await fetch(`http://127.0.0.1:${port}/v1/models?limit=1000`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ data: [], has_more: false });
    expect(state.requests).toBe(0);
    expect(state.served).toBe(0);
    const chat = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: JSON.stringify({ messages: [] }) });
    expect(await chat.json()).toEqual({ content: [{ type: "text", text: "first" }] });
    expect(state.requests).toBe(1);
  } finally { server.close(); }
});
