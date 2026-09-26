import { describe, expect, it, vi } from "vitest";
import { FakeElement } from "../fakes/obsidian";
import { SetupCard, type SetupCardDeps } from "../../src/view/chat/SetupCard";

function card(test: () => Promise<{ ok: boolean; detail: string }>): { card: SetupCard; plugin: Record<string, unknown> } {
  const plugin: Record<string, unknown> = {
    settings: { authMode: "apiKey", apiKey: "" },
    secrets: () => ({ available: () => true }),
    saveSettings: vi.fn(async () => undefined),
    continueOnboarding: vi.fn(async () => undefined),
    router: () => ({ anthropic: { test } }),
  };
  const deps: SetupCardDeps = {
    plugin: plugin as unknown as SetupCardDeps["plugin"],
    cliEntries: () => [],
    messagesEl: () => new FakeElement() as unknown as HTMLElement,
    hasMessages: () => false,
    renderEmptyState: vi.fn(),
    refreshModelLabel: vi.fn(),
    openSettings: vi.fn(),
  };
  return { card: new SetupCard(deps), plugin };
}

function render(setup: SetupCard): FakeElement {
  const parent = new FakeElement();
  setup.render(parent as unknown as HTMLElement);
  return parent;
}

const input = (parent: FakeElement): FakeElement => parent.querySelector(".cc-setup-input")!;

describe("SetupCard", () => {
  it("keeps a half-typed API key when the card re-renders", () => {
    const { card: setup } = card(async () => ({ ok: true, detail: "" }));
    const first = input(render(setup));
    first.value = "sk-ant-api-half";
    first.dispatchEvent({ type: "input" });

    expect(input(render(setup)).value).toBe("sk-ant-api-half");
  });

  it("clears the kept key once it is saved and verified", async () => {
    const { card: setup, plugin } = card(async () => ({ ok: true, detail: "" }));
    const parent = render(setup);
    input(parent).value = "sk-ant-api-full";
    input(parent).dispatchEvent({ type: "input" });
    parent.querySelector(".cc-setup-save")!.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(plugin.continueOnboarding).toHaveBeenCalled());

    expect((plugin.settings as { apiKey: string }).apiKey).toBe("sk-ant-api-full");
    expect(input(render(setup)).value).toBe("");
  });
});
