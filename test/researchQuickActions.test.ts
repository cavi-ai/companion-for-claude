import { describe, expect, it } from "vitest";
import { researchQuickActions } from "../src/view/chat/researchQuickActions";
import type { NextStep } from "../src/research/nextSteps";

describe("researchQuickActions", () => {
  it("offers only chat steps, with their prompts, at most three", () => {
    const steps: NextStep[] = [
      { id: "draft:a", label: 'Draft "A"', kind: "draft-section", sectionId: "a" },
      { id: "counter:a", label: 'Look for evidence against "A"', kind: "chat", prompt: "P1" },
      { id: "briefing", label: "Brief me on where the argument stands", kind: "chat", prompt: "P2" },
    ];
    expect(researchQuickActions(steps)).toEqual([
      { label: 'Look for evidence against "A"', prompt: "P1" },
      { label: "Brief me on where the argument stands", prompt: "P2" },
    ]);
  });
});
