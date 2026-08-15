import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import {
  SECRET_FIELDS,
  hydrate,
  secretIdFor,
  stripSecrets,
  unavailableStore,
  writeSecret,
  type SecretField,
  type SecretStore,
} from "../../src/secrets/store";

function fakeStore(initial: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    available: () => true,
    get: (id) => data[id] ?? null,
    set: (id, value) => { data[id] = value; },
  };
}

const filled = () => {
  const s = { ...DEFAULT_SETTINGS };
  for (const field of SECRET_FIELDS) s[field] = `secret-${field}`;
  return s;
};

describe("secret ids", () => {
  it("covers every credential field", () => {
    expect(SECRET_FIELDS).toEqual([
      "apiKey",
      "oauthToken",
      "openaiCompatKey",
      "zoteroApiKey",
      "braveSearchApiKey",
      "mcpToken",
      "cloudRoutineToken",
      "cloudReplyToken",
    ]);
  });

  it("only uses lowercase alphanumerics and dashes, as setSecret requires", () => {
    for (const field of SECRET_FIELDS) {
      expect(secretIdFor(field)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("gives each field a distinct id", () => {
    const ids = SECRET_FIELDS.map(secretIdFor);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("stripSecrets", () => {
  it("blanks every credential", () => {
    const stripped = stripSecrets(filled());
    for (const field of SECRET_FIELDS) expect(stripped[field]).toBe("");
  });

  it("leaves non-credential settings alone", () => {
    const settings = { ...filled(), model: "claude-opus-5", mcpPort: 22360 };
    const stripped = stripSecrets(settings);
    expect(stripped.model).toBe("claude-opus-5");
    expect(stripped.mcpPort).toBe(22360);
  });

  it("does not mutate its input", () => {
    const settings = filled();
    stripSecrets(settings);
    expect(settings.apiKey).toBe("secret-apiKey");
  });
});

describe("hydrate", () => {
  it("fills credentials from the store", () => {
    const store = fakeStore({ [secretIdFor("apiKey")]: "sk-ant-api-live" });
    const out = hydrate(stripSecrets(filled()), store);
    expect(out.apiKey).toBe("sk-ant-api-live");
  });

  it("leaves a field empty when the store has nothing for it", () => {
    const out = hydrate(stripSecrets(filled()), fakeStore());
    expect(out.oauthToken).toBe("");
  });

  it("returns settings unchanged when the store is unavailable", () => {
    const settings = filled();
    expect(hydrate(settings, unavailableStore()).apiKey).toBe("secret-apiKey");
  });

  it("round-trips through strip and hydrate", () => {
    const store = fakeStore();
    const settings = filled();
    for (const field of SECRET_FIELDS) writeSecret(store, field, settings[field]);
    const out = hydrate(stripSecrets(settings), store);
    for (const field of SECRET_FIELDS) expect(out[field]).toBe(`secret-${field}`);
  });
});

describe("writeSecret", () => {
  it("writes through when available", () => {
    const store = fakeStore();
    writeSecret(store, "mcpToken" as SecretField, "tok");
    expect(store.data[secretIdFor("mcpToken")]).toBe("tok");
  });

  it("is a no-op when unavailable", () => {
    expect(() => writeSecret(unavailableStore(), "apiKey", "x")).not.toThrow();
  });
});
