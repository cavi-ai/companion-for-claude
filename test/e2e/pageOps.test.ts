import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { closeResetViews } from "../../e2e/rig/pageOps";

afterEach(() => vi.unstubAllGlobals());

describe("fixture editor shutdown", () => {
  it("waits for native Markdown unload/save before detaching or disabling Companion", async () => {
    let acknowledge!: () => void;
    const pending = new Promise<void>(resolve => { acknowledge = resolve; });
    const detached = vi.fn();
    const disablePlugin = vi.fn(async () => {});
    const setViewState = vi.fn(() => pending);
    const leaf = { setViewState, detach: detached };
    vi.stubGlobal("window", { app: { workspace: { getLeavesOfType: (type: string) => type === "markdown" ? [leaf] : [] }, plugins: { disablePlugin } } });
    const page = { evaluate: (callback: () => Promise<void>) => callback() } as unknown as Page;

    const closing = closeResetViews(page);
    await Promise.resolve();
    expect(setViewState).toHaveBeenCalledWith({ type: "empty" });
    expect(detached).not.toHaveBeenCalled();
    expect(disablePlugin).not.toHaveBeenCalled();
    acknowledge();
    await closing;
    expect(detached).toHaveBeenCalledOnce();
    expect(disablePlugin).toHaveBeenCalledWith("claude-companion");
  });

  it("propagates an editor-close failure before fixture deletion can proceed", async () => {
    const detached = vi.fn();
    const disablePlugin = vi.fn(async () => {});
    const leaf = { setViewState: vi.fn(async () => { throw new Error("Editor save failed"); }), detach: detached };
    vi.stubGlobal("window", { app: { workspace: { getLeavesOfType: (type: string) => type === "markdown" ? [leaf] : [] }, plugins: { disablePlugin } } });
    const page = { evaluate: (callback: () => Promise<void>) => callback() } as unknown as Page;

    await expect(closeResetViews(page)).rejects.toThrow("Editor save failed");
    expect(detached).not.toHaveBeenCalled();
    expect(disablePlugin).not.toHaveBeenCalled();
  });
});
