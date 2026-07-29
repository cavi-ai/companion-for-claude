import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  PluginSettingTab: class {},
}));

import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { AGENT_INSTRUCTION, PLAN_MODE_INSTRUCTION } from "../../src/agent/prompt";
import { PLANNING_INSTRUCTION } from "../../src/artifacts/designSystem";

function pluginHarness(): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS };
  Object.defineProperty(plugin, "ontology", { value: () => null });
  return plugin;
}

describe("agent system prompt", () => {
  it("tells the agent to act on action requests instead of producing plans", () => {
    // Regression: the agent answered "do X" requests with a planning artifact
    // and a Build tasks checklist instead of using its vault tools.
    expect(AGENT_INSTRUCTION).toMatch(/act, don't just advise/i);
    expect(AGENT_INSTRUCTION).toMatch(/not a request for a plan/i);
    expect(AGENT_INSTRUCTION).toContain("## Build tasks");
    expect(AGENT_INSTRUCTION).toMatch(/never substitute a plan for the action/i);
  });

  it("keeps Plan Mode read-only and plan-shaped", () => {
    expect(PLAN_MODE_INSTRUCTION).toMatch(/read-only/i);
    expect(PLAN_MODE_INSTRUCTION).toMatch(/do NOT attempt writes/i);
  });

  it("composes agent turns with the action instruction and without the planning template", () => {
    const plugin = pluginHarness();
    const agent = plugin.composeSystemPrompt({ agent: true });
    expect(agent).toContain(AGENT_INSTRUCTION);
    expect(agent).not.toContain(PLAN_MODE_INSTRUCTION);
    // The two-part implementation-plan template belongs to the explicit plan
    // command only — in agent turns it pulls the model toward planning artifacts.
    expect(agent).not.toContain(PLANNING_INSTRUCTION);
  });

  it("layers Plan Mode only on agent turns that ask for it", () => {
    const plugin = pluginHarness();
    expect(plugin.composeSystemPrompt()).not.toContain(AGENT_INSTRUCTION);
    expect(plugin.composeSystemPrompt()).not.toContain(PLAN_MODE_INSTRUCTION);
    const plan = plugin.composeSystemPrompt({ agent: true, plan: true });
    expect(plan).toContain(AGENT_INSTRUCTION);
    expect(plan).toContain(PLAN_MODE_INSTRUCTION);
  });
});
