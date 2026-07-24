import { describe, expect, it } from "vitest";
import { App, WorkspaceLeaf } from "obsidian";
import type { Provider } from "../../src/providers/types";
import { IntelligenceCoordinator, type IntelligenceNarratorMode } from "../../src/research/intelligenceCoordinator";
import type { ResearchNoteInput } from "../../src/research/parse";
import { ResearchRepository } from "../../src/research/repository";
import { ResearchWorkbenchView } from "../../src/view/ResearchWorkbenchView";

const PROJECT = "Research/P/Project.md";
const QUESTION = "Research/P/Questions/Open question.md";

function projectNotes(questionStatus: "open" | "resolved" = "open"): ResearchNoteInput[] {
  return [
    { path: PROJECT, body: "", frontmatter: { title: "Project P", type: "research-project", project: `[[${PROJECT}]]`, question: "What is supported?", stage: "reason", status: "active" } },
    { path: QUESTION, body: "", frontmatter: { title: "Open question", type: "research-question", project: `[[${PROJECT}]]`, question: "What changed?", status: questionStatus } },
  ];
}

function text(root: HTMLElement): string {
  const visit = (node: { textContent?: string; children?: unknown[] }): string =>
    [node.textContent ?? "", ...(node.children ?? []).map((child) => visit(child as never))].join(" ");
  return visit(root as never);
}

function click(root: HTMLElement, label: string): void {
  const element = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!element) throw new Error(`Button not found: ${label}`);
  element.dispatchEvent(new Event("click"));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function intelligenceFlowHarness(input: {
  narrator: IntelligenceNarratorMode;
  responses?: string[];
}) {
  let notes = projectNotes();
  const providerCalls: string[] = [];
  const vaultWrites: string[] = [];
  const responses = [...(input.responses ?? [JSON.stringify({
    briefing: "The open question needs investigation.",
    groups: [{ title: "Next step", insights: [{ text: "Resolve the captured question.", epistemicStatus: "suggested-investigation", paths: [QUESTION] }] }],
  })])];
  const app = new App();
  for (const method of ["createFolder", "create", "append", "modify"] as const) {
    const vault = app.vault as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = vault[method].bind(app.vault);
    vault[method] = (...args: unknown[]) => { vaultWrites.push(method); return original(...args); };
  }
  const local: Provider = {
    id: "ollama", label: "Local model", hasCredentials: () => true,
    complete: async () => { providerCalls.push("ollama"); return responses.shift() ?? "{}"; },
    stream: async () => undefined, test: async () => ({ ok: true, detail: "ready" }),
  };
  const anthropic: Provider = {
    id: "anthropic", label: "Anthropic", hasCredentials: () => true,
    complete: async () => { providerCalls.push("anthropic"); return responses.shift() ?? "{}"; },
    stream: async () => undefined, test: async () => ({ ok: true, detail: "ready" }),
  };
  const repository = new ResearchRepository({
    listMarkdown: async () => notes,
    listProjectMarkdown: async () => notes,
    createWithParents: async () => { vaultWrites.push("repository:create"); },
    updateFrontmatter: async () => { vaultWrites.push("repository:update"); },
  });
  const coordinator = new IntelligenceCoordinator({
    mode: () => input.narrator,
    chatBackend: () => "auto",
    anthropic: () => ({ provider: anthropic, model: "claude-test" }),
    local: () => ({ provider: local, model: "qwen-test" }),
    localAvailable: async () => true,
    maxTokens: () => 800,
  });
  const view = new ResearchWorkbenchView(new WorkspaceLeaf(app), repository, { coordinator, narratorMode: () => input.narrator });
  return {
    view, providerCalls, vaultWrites,
    replaceNotes(next: ResearchNoteInput[]) { notes = next; },
    async openIntelligence() { click(view.contentEl, "Intelligence"); await settle(); },
    async clickAnalyze(label = "Analyze") { click(view.contentEl, label); await settle(); },
  };
}

describe("Research Intelligence end-to-end safety flow", () => {
  it("runs explicit Local-only analysis, identifies its provider, marks edits stale, and never writes", async () => {
    const harness = intelligenceFlowHarness({ narrator: "local" });
    await harness.view.setProjectPath(PROJECT);
    await harness.openIntelligence();
    expect(harness.providerCalls).toEqual([]);

    await harness.clickAnalyze();
    expect(harness.providerCalls).toEqual(["ollama"]);
    expect(text(harness.view.contentEl)).toContain("Ollama");
    expect(text(harness.view.contentEl)).toContain("qwen-test");

    harness.replaceNotes(projectNotes("resolved"));
    await harness.view.render();
    expect(text(harness.view.contentEl)).toContain("Out of date");
    expect(harness.providerCalls).toEqual(["ollama"]);
    expect(harness.vaultWrites).toEqual([]);
  });

  it("keeps model analysis Disabled without calling either provider or writing", async () => {
    const harness = intelligenceFlowHarness({ narrator: "disabled" });
    await harness.view.setProjectPath(PROJECT);
    await harness.openIntelligence();
    expect(text(harness.view.contentEl)).toContain("Model analysis is disabled in settings.");
    expect(harness.providerCalls).toEqual([]);
    expect(harness.vaultWrites).toEqual([]);
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["unknown citations", JSON.stringify({ briefing: "Unverified", groups: [{ title: "Bad", insights: [{ text: "Invented", epistemicStatus: "inference", paths: ["Unknown.md"] }] }] })],
  ])("retains the verified narrative as stale after %s", async (_case, invalidResponse) => {
    const valid = JSON.stringify({ briefing: "Verified briefing", groups: [{ title: "Verified", insights: [{ text: "Check the question.", epistemicStatus: "observation", paths: [QUESTION] }] }] });
    const harness = intelligenceFlowHarness({ narrator: "local", responses: [valid, invalidResponse] });
    await harness.view.setProjectPath(PROJECT);
    await harness.openIntelligence();
    await harness.clickAnalyze();
    await harness.clickAnalyze("Analyze again");

    expect(text(harness.view.contentEl)).toContain("could not be verified");
    expect(text(harness.view.contentEl)).toContain("Verified briefing");
    expect(harness.view.contentEl.querySelector(".cc-intelligence-stale")).not.toBeNull();
    expect(harness.providerCalls).toEqual(["ollama", "ollama"]);
    expect(harness.vaultWrites).toEqual([]);
  });

  it("refreshes deterministic findings after an edit resolves a question without a provider call", async () => {
    const harness = intelligenceFlowHarness({ narrator: "local" });
    await harness.view.setProjectPath(PROJECT);
    await harness.openIntelligence();
    expect(text(harness.view.contentEl)).toContain("Research question remains open");

    harness.replaceNotes(projectNotes("resolved"));
    await harness.view.render();
    expect(text(harness.view.contentEl)).not.toContain("Research question remains open");
    expect(harness.providerCalls).toEqual([]);
    expect(harness.vaultWrites).toEqual([]);
  });
});
