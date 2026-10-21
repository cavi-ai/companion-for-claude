import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { renderCanvasResult } from "../../src/view/chat/canvasResult";

describe("Canvas results", () => {
  it("opens a successful generated Canvas in a tab", async () => {
    const app = new App();
    const file = app.vault.seed("Maps/Project context.canvas", "{}");
    const openFile = vi.fn(async () => undefined);
    Object.assign(app.workspace, { getLeaf: vi.fn(() => ({ openFile })) });
    const parent = new FakeElement("div");
    renderCanvasResult(app, parent as unknown as HTMLElement, "canvas_create", "Created canvas: Maps/Project context.canvas (5 nodes, 5 edges)", true);
    const button = parent.querySelector("button");
    expect(button?.textContent).toBe("Open Canvas");
    button?.dispatchEvent({ type: "click" });
    await Promise.resolve();
    expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(openFile).toHaveBeenCalledWith(file);
  });

  it("does not offer failed, missing, unrelated or unsafe outputs", () => {
    const app = new App();
    for (const [name, result, ok] of [
      ["canvas_create", "Created canvas: Missing.canvas (1 nodes, 0 edges)", true],
      ["canvas_create", "Created canvas: ../Outside.canvas (1 nodes, 0 edges)", true],
      ["canvas_create", "Created canvas: /Outside.canvas (1 nodes, 0 edges)", true],
      ["canvas_create", "Created canvas: Good.canvas (1 nodes, 0 edges)", false],
      ["note_read", "Created canvas: Good.canvas (1 nodes, 0 edges)", true],
    ] as const) {
      app.vault.seed("Good.canvas", "{}");
      const parent = new FakeElement("div");
      renderCanvasResult(app, parent as unknown as HTMLElement, name, result, ok);
      expect(parent.querySelector("button")).toBeNull();
    }
  });
});
