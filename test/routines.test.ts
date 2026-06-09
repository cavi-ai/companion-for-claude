import { describe, it, expect } from "vitest";
import { configError, buildFireRequest, parseFireResponse, composeDispatchText, type CloudDispatchConfig } from "../src/cloud/routines";

const ok: CloudDispatchConfig = {
  fireUrl: "https://api.anthropic.com/v1/claude_code/routines/r_123/fire",
  token: "sk-ant-oat01-secret",
  betaHeader: "experimental-cc-routine-2026-04-01",
};

describe("configError", () => {
  it("passes a complete config", () => {
    expect(configError(ok)).toBeNull();
  });
  it("requires a fire URL", () => {
    expect(configError({ ...ok, fireUrl: "" })).toMatch(/endpoint/i);
  });
  it("rejects a non-URL endpoint", () => {
    expect(configError({ ...ok, fireUrl: "not a url" })).toMatch(/valid URL/i);
  });
  it("rejects a non-https endpoint", () => {
    expect(configError({ ...ok, fireUrl: "http://api.anthropic.com/x/fire" })).toMatch(/https/i);
  });
  it("requires a token", () => {
    expect(configError({ ...ok, token: "  " })).toMatch(/token/i);
  });
  it("requires the beta header", () => {
    expect(configError({ ...ok, betaHeader: "" })).toMatch(/anthropic-beta/i);
  });
});

describe("buildFireRequest", () => {
  it("builds a POST with bearer + beta headers and a {text} body", () => {
    const req = buildFireRequest(ok, "do the thing");
    expect(req.method).toBe("POST");
    expect(req.url).toBe(ok.fireUrl);
    expect(req.headers.authorization).toBe("Bearer sk-ant-oat01-secret");
    expect(req.headers["anthropic-beta"]).toBe(ok.betaHeader);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ text: "do the thing" });
  });
  it("trims the URL and token", () => {
    const req = buildFireRequest({ ...ok, fireUrl: ` ${ok.fireUrl} `, token: " tok " }, "x");
    expect(req.url).toBe(ok.fireUrl);
    expect(req.headers.authorization).toBe("Bearer tok");
  });
  it("throws on an invalid config", () => {
    expect(() => buildFireRequest({ ...ok, token: "" }, "x")).toThrow(/token/i);
  });
});

describe("parseFireResponse", () => {
  it("extracts the session id + url on success", () => {
    const body = JSON.stringify({
      type: "routine_fire",
      claude_code_session_id: "session_01",
      claude_code_session_url: "https://claude.ai/code/session_01",
    });
    expect(parseFireResponse(200, body)).toEqual({
      sessionId: "session_01",
      sessionUrl: "https://claude.ai/code/session_01",
    });
  });
  it("tolerates a 2xx body missing the fields", () => {
    expect(parseFireResponse(202, "{}")).toEqual({ sessionId: null, sessionUrl: null });
  });
  it("tolerates a 2xx unparseable body", () => {
    expect(parseFireResponse(200, "not json")).toEqual({ sessionId: null, sessionUrl: null });
  });
  it("explains a 401 as a token problem", () => {
    expect(() => parseFireResponse(401, "{}")).toThrow(/token/i);
  });
  it("explains a 404 as a wrong routine", () => {
    expect(() => parseFireResponse(404, "{}")).toThrow(/not found|routine id/i);
  });
  it("flags the experimental header on a 400", () => {
    expect(() => parseFireResponse(400, "{}")).toThrow(/experimental|anthropic-beta/i);
  });
  it("surfaces an Anthropic error message from the body", () => {
    const body = JSON.stringify({ error: { message: "routine is disabled" } });
    expect(() => parseFireResponse(400, body)).toThrow(/routine is disabled/);
  });
});

describe("composeDispatchText", () => {
  it("returns just the instruction when there is no context", () => {
    expect(composeDispatchText("  summarize  ")).toBe("summarize");
  });
  it("appends a context block when context is present", () => {
    const out = composeDispatchText("summarize", "Active note: A.md");
    expect(out).toContain("summarize");
    expect(out).toContain("Context from my Obsidian vault:");
    expect(out).toContain("Active note: A.md");
  });
  it("ignores blank context", () => {
    expect(composeDispatchText("summarize", "   ")).toBe("summarize");
  });
});
