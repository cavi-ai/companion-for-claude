import { describe, expect, it, vi } from "vitest";
import { ConnectionController } from "../../src/providers/connection";
import { DEFAULT_SETTINGS } from "../../src/types";
import { FakeElement, fakeDocument } from "../fakes/obsidian";
import { codexBackend } from "../../src/cli/backends/codex";
import { claudeBackend } from "../../src/cli/backends/claude";
import { SetupCard, type SetupCardDeps } from "../../src/view/chat/SetupCard";

function card(test: () => Promise<{ ok: boolean; detail: string }>): { card: SetupCard; plugin: Record<string, unknown>; deps: SetupCardDeps } {
  const values = new Map<string, string>();
  const plugin: Record<string, unknown> = {
    settings: { ...structuredClone(DEFAULT_SETTINGS), chatBackend: "claude-cli" },
    secrets: () => ({ available: () => true, get: (id: string) => values.get(id) ?? null, set: (id: string, value: string) => { values.set(id, value); return true; } }),
    saveSettings: vi.fn(async () => undefined),

    router: () => ({ anthropic: { test } }),
  };
  const connection = new ConnectionController({ settings: () => plugin.settings as typeof DEFAULT_SETTINGS, test,
    save: () => (plugin.saveSettings as () => Promise<void>)(),
    store: (plugin.secrets as () => import("../../src/secrets/store").SecretStore)(),
  });
  plugin.connection = () => connection;
  const deps: SetupCardDeps = {
    plugin: plugin as unknown as SetupCardDeps["plugin"],
    cliEntries: () => [],
    messagesEl: () => new FakeElement() as unknown as HTMLElement,
    hasMessages: () => false,
    renderEmptyState: vi.fn(),
    refreshModelLabel: vi.fn(),
    openSettings: vi.fn(),
  };
  return { card: new SetupCard(deps), plugin, deps };
}

function render(setup: SetupCard): FakeElement {
  const parent = new FakeElement();
  setup.render(parent as unknown as HTMLElement);
  return parent;
}

const input = (parent: FakeElement): FakeElement => parent.querySelector(".cc-setup-input")!;

describe("SetupCard", () => {
  it("adds a detected CLI connection without replacing the focused API field during typing", async () => {
    const { card: setup, deps } = card(async () => ({ ok: true, detail: "Connected" }));
    const parent = new FakeElement();
    let signedIn = false;
    let finish!: () => void;
    deps.cliEntries = () => [
      { backend: claudeBackend, provider: { available: () => true, hasCredentials: () => true, refresh: async () => undefined } },
      { backend: codexBackend, provider: { available: () => true, hasCredentials: () => signedIn, refresh: () => new Promise<void>(resolve => { finish = resolve; }) } },
    ];
    deps.messagesEl = () => parent as unknown as HTMLElement;
    deps.renderEmptyState = () => { parent.empty(); setup.render(parent as unknown as HTMLElement); };
    setup.render(parent as unknown as HTMLElement);
    const field = input(parent);
    field.focus();
    field.value = "sk-ant-api-in-progress"; // The browser has changed the value; its input event has not arrived yet.
    signedIn = true;
    finish();
    await vi.waitFor(() => expect(parent.querySelectorAll(".cc-setup-cli-use")).toHaveLength(2));
    expect(input(parent)).toBe(field);
    expect(input(parent).value).toBe("sk-ant-api-in-progress");
    expect(fakeDocument.activeElement).toBe(field);
  });
  it("keeps a half-typed API key when the card re-renders", () => {
    const { card: setup } = card(async () => ({ ok: true, detail: "" }));
    const first = input(render(setup));
    first.value = "sk-ant-api-half";
    first.dispatchEvent({ type: "input" });

    expect(input(render(setup)).value).toBe("sk-ant-api-half");
  });

  it("submits Enter once, while composition and duplicate submissions do nothing", async () => {
    const test = vi.fn(async () => ({ ok: true, detail: "" }));
    const { card: setup, plugin } = card(test);
    const parent = render(setup);
    input(parent).value = "audit-key";
    input(parent).dispatchEvent({ type: "keydown", key: "Enter", isComposing: true, preventDefault() {} });
    expect(test).not.toHaveBeenCalled();
    input(parent).dispatchEvent({ type: "keydown", key: "Enter", isComposing: false, preventDefault() {} });
    await vi.waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((plugin.settings as { chatBackend: string }).chatBackend).toBe("claude"));
    expect((plugin.settings as { chatBackend: string }).chatBackend).toBe("claude");
  });

  it("shows a thrown connection error, enables retry and accepts Enter afterward", async () => {
    const verify = vi.fn().mockRejectedValueOnce(new Error("Transport failed")).mockResolvedValue({ ok: true, detail: "Connected" });
    const { card: setup, plugin } = card(verify);
    const parent = render(setup);
    input(parent).value = "audit-key";
    parent.querySelector(".cc-setup-save")!.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(parent.querySelector(".cc-setup-status")?.textContent).toBe("Transport failed"));
    expect(parent.querySelector(".cc-setup-save")?.disabled).toBe(false);
    input(parent).dispatchEvent({ type: "keydown", key: "Enter", isComposing: false, preventDefault() {} });
    await vi.waitFor(() => expect((plugin.settings as { chatBackend: string }).chatBackend).toBe("claude"));
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("clears the kept key once it is saved and verified", async () => {
    const { card: setup, plugin } = card(async () => ({ ok: true, detail: "" }));
    const parent = render(setup);
    input(parent).value = "sk-ant-api-full";
    input(parent).dispatchEvent({ type: "input" });
    parent.querySelector(".cc-setup-save")!.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect((plugin.settings as { apiKey: string }).apiKey).toBe("sk-ant-api-full"));

    expect((plugin.settings as { apiKey: string }).apiKey).toBe("sk-ant-api-full");
    expect(input(render(setup)).value).toBe("");
  });
});
