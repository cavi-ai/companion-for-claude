import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import { SECRET_FIELDS, secretIdFor, unavailableStore, type SecretStore } from "../../src/secrets/store";
import { migrateSecrets, migrationNotice, pendingSecrets } from "../../src/secrets/migrate";

function fakeStore(): SecretStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    available: () => true,
    get: (id) => data[id] ?? null,
    set: (id, value) => { data[id] = value; return true; },
  };
}

/** Accepts every write, keeps none — the shape a keyring-less backend can take. */
function droppingStore(): SecretStore {
  return { available: () => true, get: () => null, set: () => false };
}

describe("pendingSecrets", () => {
  it("is empty for default settings", () => {
    expect(pendingSecrets(DEFAULT_SETTINGS)).toEqual([]);
  });

  it("ignores whitespace-only values", () => {
    expect(pendingSecrets({ ...DEFAULT_SETTINGS, apiKey: "   " })).toEqual([]);
  });

  it("reports each populated credential", () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x", cloudReplyToken: "ghp_x" };
    expect(pendingSecrets(settings)).toEqual(["apiKey", "cloudReplyToken"]);
  });
});

describe("migrateSecrets", () => {
  it("moves plaintext into the store and blanks the field", () => {
    const store = fakeStore();
    const { moved, settings } = migrateSecrets({ ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x" }, store);
    expect(moved).toEqual(["apiKey"]);
    expect(settings.apiKey).toBe("");
    expect(store.data[secretIdFor("apiKey")]).toBe("sk-ant-api-x");
  });

  it("moves every credential field", () => {
    const store = fakeStore();
    const seeded = { ...DEFAULT_SETTINGS };
    for (const field of SECRET_FIELDS) seeded[field] = `v-${field}`;
    const { moved, settings } = migrateSecrets(seeded, store);
    expect(moved).toEqual(SECRET_FIELDS);
    for (const field of SECRET_FIELDS) {
      expect(settings[field]).toBe("");
      expect(store.data[secretIdFor(field)]).toBe(`v-${field}`);
    }
  });

  it("is idempotent", () => {
    const store = fakeStore();
    const first = migrateSecrets({ ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x" }, store);
    const second = migrateSecrets(first.settings, store);
    expect(second.moved).toEqual([]);
    expect(store.data[secretIdFor("apiKey")]).toBe("sk-ant-api-x");
  });

  it("trims before storing", () => {
    const store = fakeStore();
    migrateSecrets({ ...DEFAULT_SETTINGS, apiKey: "  sk-ant-api-x  " }, store);
    expect(store.data[secretIdFor("apiKey")]).toBe("sk-ant-api-x");
  });

  it("leaves settings untouched when the store is unavailable", () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x" };
    const result = migrateSecrets(settings, unavailableStore());
    expect(result.moved).toEqual([]);
    expect(result.settings.apiKey).toBe("sk-ant-api-x");
  });

  it("does not mutate its input", () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x" };
    migrateSecrets(settings, fakeStore());
    expect(settings.apiKey).toBe("sk-ant-api-x");
  });

  // Blanking a field the store never kept would lose the credential outright.
  it("keeps the plaintext when the store drops the write", () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x" };
    const result = migrateSecrets(settings, droppingStore());
    expect(result.moved).toEqual([]);
    expect(result.settings.apiKey).toBe("sk-ant-api-x");
  });

  it("moves only the fields that read back", () => {
    const store = fakeStore();
    const only = secretIdFor("apiKey");
    const partial: SecretStore = {
      available: () => true,
      get: (id) => store.data[id] ?? null,
      set: (id, value) => (id === only ? store.set(id, value) : false),
    };
    const seeded = { ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-x", mcpToken: "tok" };
    const { moved, settings } = migrateSecrets(seeded, partial);
    expect(moved).toEqual(["apiKey"]);
    expect(settings.apiKey).toBe("");
    expect(settings.mcpToken).toBe("tok");
  });
});

describe("migrationNotice", () => {
  it("is empty when nothing moved", () => {
    expect(migrationNotice([])).toBe("");
  });

  it("names what moved and tells the user to rotate", () => {
    const notice = migrationNotice(["apiKey", "mcpToken"]);
    expect(notice).toContain("Anthropic API key");
    expect(notice).toContain("MCP bridge token");
    expect(notice).toContain("rotate");
  });
});
