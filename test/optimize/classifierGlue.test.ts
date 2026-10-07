import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ClassifierStoppedError, createClassifier, type ClassifierGlueDeps } from "../../src/optimize/classifierGlue";
import { VerdictParseError, parseVerdicts, type ClassifyPair } from "../../src/optimize/classify";
import type { ProviderSelection } from "../../src/providers/router";
import type { CompletionRequest } from "../../src/providers/types";

const pairs: ClassifyPair[] = [{ id: "a|b", a: "a", b: "b", aCount: 1, bCount: 1, aTitles: [], bTitles: [] }];
const req = { system: "sys", user: "usr", schema: { type: "object" } };

function setup(over: Partial<ClassifierGlueDeps> & { replies?: string[]; local?: boolean } = {}) {
  const calls: CompletionRequest[] = [];
  const replies = over.replies ?? ['{"verdicts":[{"pair":1,"verdict":"keep"}]}'];
  const provider = {
    id: "ollama",
    complete: vi.fn(async (r: CompletionRequest) => {
      calls.push(r);
      return replies[Math.min(calls.length - 1, replies.length - 1)] as string;
    }),
  };
  const selection = { provider, model: "m1", endpoint: "http://localhost:11434" } as unknown as ProviderSelection;
  const passive = { provider, model: "passive-model" } as unknown as ProviderSelection;
  const router = {
    classifierSelection: vi.fn(async () => selection),
    selectionRunsLocally: vi.fn(() => over.local ?? true),
    providerLabel: vi.fn(() => "Label"),
  };
  const deps: ClassifierGlueDeps = {
    router: () => router,
    backend: () => "utility",
    isMobile: false,
    passiveUtilitySelection: vi.fn(() => passive),
    assertActive: vi.fn(),
    ...over,
  };
  return { deps, router, provider, calls, selection, passive, classifier: createClassifier(deps) };
}

describe("createClassifier", () => {
  it("utility + non-interactive resolves passively and never calls classifierSelection", async () => {
    const s = setup();
    const c = await s.classifier({ interactive: false });
    expect(s.deps.passiveUtilitySelection).toHaveBeenCalledTimes(1);
    expect(s.router.classifierSelection).not.toHaveBeenCalled();
    expect(c.model).toBe("passive-model");
  });

  it("utility + interactive goes through classifierSelection", async () => {
    const s = setup();
    const c = await s.classifier({ interactive: true });
    expect(s.router.classifierSelection).toHaveBeenCalledWith({ isMobile: false });
    expect(s.deps.passiveUtilitySelection).not.toHaveBeenCalled();
    expect(c.model).toBe("m1");
  });

  it.each([true, false])("dedicated backend uses classifierSelection (interactive=%s)", async (interactive) => {
    const s = setup({ backend: () => "ollama" });
    await s.classifier({ interactive });
    expect(s.router.classifierSelection).toHaveBeenCalledTimes(1);
    expect(s.deps.passiveUtilitySelection).not.toHaveBeenCalled();
  });

  it("local is the router's answer for that selection, on the router that produced it", async () => {
    const s = setup({ local: false });
    const c = await s.classifier({ interactive: true });
    expect(c.local).toBe(false);
    expect(s.router.selectionRunsLocally).toHaveBeenCalledWith(s.selection);
    expect(c.label).toBe("Label");
  });

  it("sends the fixed request parameters", async () => {
    const s = setup();
    const c = await s.classifier({ interactive: true });
    await c.complete(req, (raw) => parseVerdicts(raw, pairs));
    expect(s.calls[0]).toEqual({
      system: "sys",
      messages: [{ role: "user", content: "usr" }],
      model: "m1",
      maxTokens: 900,
      temperature: 0,
      responseFormat: "json",
      responseSchema: { type: "object" },
      thinking: { type: "disabled" },
    });
  });

  it("a router identity change stops the run before the provider is called", async () => {
    const s = setup();
    let current: ClassifierGlueDeps["router"] extends () => infer R ? R : never = s.router;
    const deps = { ...s.deps, router: () => current };
    const c = await createClassifier(deps)({ interactive: true });
    await c.complete(req, (raw) => parseVerdicts(raw, pairs));
    expect(s.provider.complete).toHaveBeenCalledTimes(1);
    current = { ...s.router };
    await expect(c.complete(req, (raw) => parseVerdicts(raw, pairs))).rejects.toBeInstanceOf(ClassifierStoppedError);
    expect(s.provider.complete).toHaveBeenCalledTimes(1);
  });

  it("assertActive throwing becomes ClassifierStoppedError with no provider call", async () => {
    const s = setup();
    const c = await s.classifier({ interactive: true });
    (s.deps.assertActive as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unloaded");
    });
    await expect(c.complete(req, (raw) => parseVerdicts(raw, pairs))).rejects.toMatchObject({ name: "ClassifierStoppedError" });
    expect(s.provider.complete).not.toHaveBeenCalled();
  });

  it("round-trips a parser that does not return Verdicts", async () => {
    const s = setup({ replies: ['{"types":["project"]}'] });
    const c = await s.classifier({ interactive: true });
    const out: string[] = await c.complete(req, (raw) => (JSON.parse(raw) as { types: string[] }).types);
    expect(out).toEqual(["project"]);
  });

  it("an unloaded plugin names the model check, not the tag check", async () => {
    const message = readFileSync(fileURLToPath(new URL("../../src/main.ts", import.meta.url)), "utf8");
    expect(message).toContain("while the model check was running");
    expect(message).not.toContain("while the tag check was running");
  });

  it("garbage twice is two provider calls and a VerdictParseError", async () => {
    const s = setup({ replies: ["nope", "still nope"] });
    const c = await s.classifier({ interactive: true });
    await expect(c.complete(req, (raw) => parseVerdicts(raw, pairs))).rejects.toBeInstanceOf(VerdictParseError);
    expect(s.provider.complete).toHaveBeenCalledTimes(2);
  });
});
