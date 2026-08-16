import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { App } from "obsidian";
import { setApiVersion } from "../fakes/obsidian";
import {
  MIN_SECRET_API,
  SECRET_FIELDS,
  createSecretStore,
  hydrate,
  secretIdFor,
  stripVerifiedSecrets,
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
    set: (id, value) => { data[id] = value; return true; },
  };
}

/** A backend that accepts every write and keeps none — the Linux-without-keyring shape. */
function droppingStore(): SecretStore {
  return { available: () => true, get: () => null, set: () => false };
}

/** Writes land but the store lies about accepting them, so callers must read back. */
function unreliableStore(): SecretStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, available: () => true, get: (id) => data[id] ?? null, set: () => false };
}

const stripAll = (settings: ReturnType<typeof filled>) => stripVerifiedSecrets(settings, allHoldingStore(settings)).settings;

/** A store that already holds exactly what `settings` carries, so stripping is allowed. */
function allHoldingStore(settings: ReturnType<typeof filled>): SecretStore {
  const data: Record<string, string> = {};
  for (const field of SECRET_FIELDS) data[secretIdFor(field)] = settings[field];
  return { available: () => true, get: (id) => data[id] ?? null, set: () => true };
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

describe("stripVerifiedSecrets", () => {
  it("blanks every credential the store holds", () => {
    const settings = filled();
    const { settings: stripped, unverified } = stripVerifiedSecrets(settings, allHoldingStore(settings));
    for (const field of SECRET_FIELDS) expect(stripped[field]).toBe("");
    expect(unverified).toEqual([]);
  });

  it("leaves non-credential settings alone", () => {
    const settings = { ...filled(), model: "claude-opus-5", mcpPort: 22360 };
    const stripped = stripVerifiedSecrets(settings, allHoldingStore(settings)).settings;
    expect(stripped.model).toBe("claude-opus-5");
    expect(stripped.mcpPort).toBe(22360);
  });

  it("does not mutate its input", () => {
    const settings = filled();
    stripVerifiedSecrets(settings, allHoldingStore(settings));
    expect(settings.apiKey).toBe("secret-apiKey");
  });

  // The credential-loss guard: a backend that drops writes must not also cost the
  // user the copy in data.json.
  it("keeps credentials the store does not hold", () => {
    const settings = filled();
    const { settings: kept, unverified } = stripVerifiedSecrets(settings, droppingStore());
    for (const field of SECRET_FIELDS) expect(kept[field]).toBe(`secret-${field}`);
    expect(unverified).toEqual([...SECRET_FIELDS]);
  });

  it("strips only the fields the store actually holds", () => {
    const settings = filled();
    const store = fakeStore({ [secretIdFor("apiKey")]: settings.apiKey });
    const { settings: out, unverified } = stripVerifiedSecrets(settings, store);
    expect(out.apiKey).toBe("");
    expect(out.oauthToken).toBe("secret-oauthToken");
    expect(unverified).not.toContain("apiKey");
    expect(unverified).toContain("oauthToken");
  });

  it("blanks empty fields without consulting the store", () => {
    const settings = { ...filled(), apiKey: "" };
    const { settings: out, unverified } = stripVerifiedSecrets(settings, droppingStore());
    expect(out.apiKey).toBe("");
    expect(unverified).not.toContain("apiKey");
  });

  it("keeps a credential when the store holds a stale different value", () => {
    const settings = filled();
    const store = fakeStore({ [secretIdFor("apiKey")]: "an-older-key" });
    const { settings: out, unverified } = stripVerifiedSecrets(settings, store);
    expect(out.apiKey).toBe("secret-apiKey");
    expect(unverified).toContain("apiKey");
  });
});

describe("hydrate", () => {
  it("fills credentials from the store", () => {
    const store = fakeStore({ [secretIdFor("apiKey")]: "sk-ant-api-live" });
    const out = hydrate(stripAll(filled()), store);
    expect(out.apiKey).toBe("sk-ant-api-live");
  });

  it("leaves a field empty when the store has nothing for it", () => {
    const out = hydrate(stripAll(filled()), fakeStore());
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
    const out = hydrate(stripVerifiedSecrets(settings, store).settings, store);
    for (const field of SECRET_FIELDS) expect(out[field]).toBe(`secret-${field}`);
  });
});

describe("writeSecret", () => {
  it("writes through when available", () => {
    const store = fakeStore();
    expect(writeSecret(store, "mcpToken" as SecretField, "tok")).toBe(true);
    expect(store.data[secretIdFor("mcpToken")]).toBe("tok");
  });

  it("is a no-op when unavailable", () => {
    expect(writeSecret(unavailableStore(), "apiKey", "x")).toBe(false);
  });

  it("reports failure when the store refuses the write", () => {
    expect(writeSecret(unreliableStore(), "apiKey", "x")).toBe(false);
  });
});

// The adapter is the only place that touches Obsidian's API, so the failure
// modes the API does not document — a throwing backend, a backend that accepts a
// write and keeps nothing — have to be absorbed here.
describe("createSecretStore", () => {
  const appWith = (secretStorage: unknown): App => ({ secretStorage } as unknown as App);

  afterEach(() => setApiVersion(MIN_SECRET_API));

  it("is unavailable below the version that encrypts at rest", () => {
    setApiVersion("1.11.4");
    const store = createSecretStore(appWith({ getSecret: () => null, setSecret: () => {} }));
    expect(store.available()).toBe(false);
  });

  it("is unavailable when the API is absent", () => {
    expect(createSecretStore(appWith(undefined)).available()).toBe(false);
  });

  it("confirms a write by reading it back", () => {
    const data: Record<string, string> = {};
    const store = createSecretStore(appWith({
      getSecret: (id: string) => data[id] ?? null,
      setSecret: (id: string, value: string) => { data[id] = value; },
    }));
    expect(store.set("claude-companion-api-key", "sk-ant-api-x")).toBe(true);
    expect(store.get("claude-companion-api-key")).toBe("sk-ant-api-x");
  });

  it("reports failure when the backend keeps nothing", () => {
    const store = createSecretStore(appWith({ getSecret: () => null, setSecret: () => {} }));
    expect(store.set("claude-companion-api-key", "sk-ant-api-x")).toBe(false);
  });

  it("reports failure instead of throwing when the backend throws on write", () => {
    const store = createSecretStore(appWith({
      getSecret: () => null,
      setSecret: () => { throw new Error("no keyring available"); },
    }));
    expect(store.set("claude-companion-api-key", "sk-ant-api-x")).toBe(false);
  });

  it("reads null instead of throwing when the backend throws on read", () => {
    const store = createSecretStore(appWith({
      getSecret: () => { throw new Error("no keyring available"); },
      setSecret: () => {},
    }));
    expect(store.get("claude-companion-api-key")).toBeNull();
  });

  it("reports failure when the backend returns a different value than written", () => {
    const store = createSecretStore(appWith({
      getSecret: () => "something-else",
      setSecret: () => {},
    }));
    expect(store.set("claude-companion-api-key", "sk-ant-api-x")).toBe(false);
  });
});
