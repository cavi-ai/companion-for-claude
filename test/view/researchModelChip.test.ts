import { FakeElement } from "obsidian";
import { expect, it, vi } from "vitest";
import { renderResearchModelChip } from "../../src/view/researchModelChip";

it("uses the curated model name and keeps connection details available", () => {
  const parent = new FakeElement("div");
  const open = vi.fn();
  renderResearchModelChip(parent as unknown as HTMLElement, { model: "chat", modelId: "claude-opus-5-5", providerLabel: "Claude API", available: true }, open);
  const chip = parent.querySelector("button")!;
  expect(chip.textContent).toBe("Claude Opus 5.5");
  expect(chip.getAttribute("title")).toContain("Claude API");
  chip.dispatchEvent({ type: "click" });
  expect(open).toHaveBeenCalledOnce();
});
