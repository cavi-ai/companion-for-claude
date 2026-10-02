import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";

const render = vi.fn();
vi.mock("../../../src/view/DiscoveryPanel", () => ({
  DiscoveryPanel: class { constructor(_deps: unknown) { } render = render; dispose = vi.fn(); },
}));

import { DiscoveryModal } from "../../../src/view/research/discoveryModal";

describe("DiscoveryModal", () => {
  it("does not draw when the modal closes while a reload is in flight", async () => {
    let finish: (value: never) => void = () => undefined;
    const reload = vi.fn(() => new Promise<never>((resolve) => { finish = resolve; }));
    const modal = new DiscoveryModal(new App() as never, {} as never, {} as never, reload, vi.fn(async () => undefined), vi.fn());
    modal.onOpen();
    render.mockClear();
    const drawing = (modal as unknown as { draw(reload: boolean): Promise<void> }).draw(true);
    modal.onClose();
    finish({} as never);
    await expect(drawing).resolves.toBeUndefined();
    expect(render).not.toHaveBeenCalled();
  });
});
