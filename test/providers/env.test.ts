import { afterEach, describe, expect, it } from "vitest";
import { hasAnthropicEnvCredential, readAnthropicEnv } from "../../src/providers/env";

const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;
const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
const realProcess = host.process;

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  host.process = { env: { ...values } };
}

afterEach(() => {
  host.process = realProcess;
});

describe("readAnthropicEnv", () => {
  it("snapshots every Anthropic variable that is set", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-key", ANTHROPIC_AUTH_TOKEN: "sk-ant-oat", ANTHROPIC_BASE_URL: "https://gw.example" });
    expect(readAnthropicEnv()).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-key",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat",
      ANTHROPIC_BASE_URL: "https://gw.example",
    });
  });

  it("omits variables that are unset rather than reporting them as undefined", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-key" });
    const env = readAnthropicEnv();
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-key" });
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
  });

  it("keeps an explicitly empty variable so the caller can tell it apart from unset", () => {
    setEnv({ ANTHROPIC_API_KEY: "" });
    expect(readAnthropicEnv()).toEqual({ ANTHROPIC_API_KEY: "" });
  });

  it("returns nothing when the runtime exposes no process", () => {
    host.process = undefined;
    expect(readAnthropicEnv()).toEqual({});
  });

  it("returns nothing when process carries no env", () => {
    host.process = {};
    expect(readAnthropicEnv()).toEqual({});
  });

  it("returns nothing when reading the environment throws", () => {
    Object.defineProperty(host, "process", {
      configurable: true,
      get() { throw new Error("sandboxed"); },
    });
    expect(readAnthropicEnv()).toEqual({});
    delete (host as Record<string, unknown>).process;
  });
});

describe("hasAnthropicEnvCredential", () => {
  it.each([
    ["an api key", { ANTHROPIC_API_KEY: "sk-ant-key" }, true],
    ["an auth token", { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat" }, true],
    ["either credential alongside a base url", { ANTHROPIC_API_KEY: "sk-ant-key", ANTHROPIC_BASE_URL: "https://gw" }, true],
    ["a base url alone", { ANTHROPIC_BASE_URL: "https://gw" }, false],
    ["an empty key", { ANTHROPIC_API_KEY: "" }, false],
    ["a whitespace-only key", { ANTHROPIC_API_KEY: "   " }, false],
    ["a whitespace-only token", { ANTHROPIC_AUTH_TOKEN: "\t\n" }, false],
    ["nothing at all", {}, false],
  ])("is %s -> %s", (_label, env, expected) => {
    expect(hasAnthropicEnvCredential(env)).toBe(expected);
  });

  it("reads the live environment when given no argument", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-key" });
    expect(hasAnthropicEnvCredential()).toBe(true);
    setEnv({});
    expect(hasAnthropicEnvCredential()).toBe(false);
  });
});
