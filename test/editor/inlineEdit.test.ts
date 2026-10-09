import { describe, expect, it, vi } from "vitest";
import { CHANGED_UNDER_EDIT, applyModalRewrite, commitModalRewrite, inlineEditMenuTitle, planModalRewrite, runInlineEdit, type InlineEditDeps, type CompleteRequest } from "../../src/editor/inlineEdit";
import type { InlinePromptHandle, InlinePromptOptions } from "../../src/editor/inlinePrompt";
import type { InlineDiffSession } from "../../src/editor/inlineDiffState";
import { ProviderRouter } from "../../src/providers/router";
import { DEFAULT_SETTINGS } from "../../src/types";
import { REWRITE_PRESETS, REWRITE_SYSTEM, INSERT_SYSTEM, buildRewriteUser, rewriteMaxTokens, parseRewrite } from "../../src/edit/rewrite";

const DOC = "# Plan\n\nCreate the parser\nShip it\n";
const SEL_FROM = DOC.indexOf("Create");
const SEL_TO = SEL_FROM + "Create the parser".length;
const AT = DOC.indexOf("Ship");

interface Harness {
  deps: InlineEditDeps;
  prompt: { opts: InlinePromptOptions | null; abort: AbortController; closed: number; range: { from: number; to: number } | null; settled: boolean; cancelled: boolean; escape(): void };
  requests: CompleteRequest[];
  sessions: InlineDiffSession[];
  notices: string[];
  modal: ReturnType<typeof vi.fn>;
  doc: { value: string };
}

function harness(opts: { instruction?: string | null; reply?: string | Error | ((signal: AbortSignal) => Promise<string>); inlineDiff?: boolean; accept?: boolean[] | null; range?: { from: number; to: number } | null } = {}): Harness {
  const doc = { value: DOC };
  const prompt: Harness["prompt"] = { opts: null, abort: new AbortController(), closed: 0, range: null, settled: false, cancelled: false, escape: () => {} };
  const requests: CompleteRequest[] = [];
  const sessions: InlineDiffSession[] = [];
  const notices: string[] = [];
  const modal = vi.fn(async () => {});
  const deps: InlineEditDeps = {
    path: "Plan.md",
    inlineDiffEnabled: opts.inlineDiff ?? true,
    openPrompt(o) {
      prompt.opts = o;
      prompt.range = opts.range === undefined ? { from: o.from, to: o.to } : opts.range;
      const instruction = opts.instruction === undefined ? "tighten" : opts.instruction;
      // Production: a submitted prompt is running; Esc or teardown aborts it until settle().
      const cancel = () => {
        if (instruction === null || prompt.settled || prompt.cancelled) return;
        prompt.cancelled = true;
        prompt.abort.abort();
      };
      prompt.escape = cancel;
      const handle: InlinePromptHandle = {
        instruction: Promise.resolve(instruction),
        signal: prompt.abort.signal,
        get cancelled() {
          return prompt.cancelled;
        },
        range: () => prompt.range,
        settle: () => {
          prompt.settled = true;
        },
        close: () => {
          prompt.closed++;
          cancel();
        },
      };
      return handle;
    },
    complete: async (req) => {
      requests.push(req);
      const r = opts.reply ?? "Build the tokenizer";
      if (typeof r === "function") return r(req.signal);
      if (r instanceof Error) throw r;
      return r;
    },
    currentDoc: () => doc.value,
    review: async (session) => {
      sessions.push(session);
      const accepted = opts.accept === undefined ? [true] : opts.accept;
      if (accepted?.[0]) {
        const h = session.hunks[0]!;
        doc.value = doc.value.slice(0, h.from) + h.newText + doc.value.slice(h.to);
      }
      return accepted;
    },
    reviewModal: modal,
    notice: (m) => notices.push(m),
    begin: () => ({ finish: () => {}, fail: () => {} }),
    failureMessage: (e) => `Edit failed — ${e instanceof Error ? e.message : String(e)}`,
  };
  return { deps, prompt, requests, sessions, notices, modal, doc };
}

describe("inlineEditMenuTitle", () => {
  it("names rewrite with a selection and writing at the cursor without one", () => {
    expect(inlineEditMenuTitle("Create the parser")).toBe("Rewrite with Claude…");
    expect(inlineEditMenuTitle("")).toBe("Write with Claude at cursor…");
  });

  it("a whitespace-only selection is not offered as a rewrite", () => {
    expect(inlineEditMenuTitle("  \n\t")).toBe("Write with Claude at cursor…");
  });
});

describe("runInlineEdit — selection mode", () => {
  it("sends today's rewrite request and reviews today's replacement inline", async () => {
    const h = harness();
    expect(await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps)).toBe("applied");
    expect(h.prompt.opts).toMatchObject({ mode: "rewrite", from: SEL_FROM, to: SEL_TO, presets: REWRITE_PRESETS });
    expect(h.requests[0]).toMatchObject({
      system: REWRITE_SYSTEM,
      user: buildRewriteUser("Create the parser", "tighten"),
      maxTokens: rewriteMaxTokens("Create the parser"),
      temperature: 0.3,
    });
    expect(h.requests[0]!.signal).toBe(h.prompt.abort.signal);
    expect(h.sessions[0]).toEqual({
      path: "Plan.md",
      description: "Rewrite — tighten",
      hunks: [{ index: 0, from: SEL_FROM, to: SEL_TO, oldText: "Create the parser", newText: parseRewrite("Build the tokenizer", "Create the parser"), status: "pending" }],
    });
    expect(h.prompt.closed).toBe(1);
    expect(h.notices).toEqual(["Rewrite applied."]);
  });

  it("reviews over the mapped range when text above moved it", async () => {
    const h = harness();
    h.deps.openPrompt = ((open) => (o: InlinePromptOptions) => {
      const handle = open(o);
      h.doc.value = "## " + DOC;
      h.prompt.range = { from: o.from + 3, to: o.to + 3 };
      return handle;
    })(h.deps.openPrompt.bind(h.deps));
    await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps);
    expect(h.sessions[0]!.hunks[0]).toMatchObject({ from: SEL_FROM + 3, to: SEL_TO + 3, oldText: "Create the parser" });
    expect(h.doc.value).toBe("## # Plan\n\nBuild the tokenizer\nShip it\n");
  });

  it("with inline diff off, hands the rewrite to the review modal and writes nothing itself", async () => {
    const h = harness({ inlineDiff: false });
    await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps);
    expect(h.sessions).toHaveLength(0);
    expect(h.modal).toHaveBeenCalledWith({ selection: "Create the parser", rewritten: "Build the tokenizer", instruction: "tighten", from: SEL_FROM, to: SEL_TO });
    expect(h.doc.value).toBe(DOC);
  });

  it("a whitespace-only selection runs nothing", async () => {
    const h = harness();
    expect(await runInlineEdit({ doc: "a   b", from: 1, to: 4 }, h.deps)).toBe("skipped");
    expect(h.prompt.opts).toBeNull();
    expect(h.notices).toEqual(["Select some text to rewrite, or place the cursor to write."]);
  });
});

describe("modal rewrite (inline diff off)", () => {
  const NOTE = "TODO\n\nTODO\n";
  const second = { selection: "TODO", rewritten: "Done", instruction: "finish", from: 6, to: 10 };

  async function commit(current: string): Promise<{ written: string; notices: string[] }> {
    const prepared = planModalRewrite(NOTE, second);
    const notices: string[] = [];
    let written = current;
    await commitModalRewrite(async (transform) => { written = transform(current); }, prepared, [true], (m) => notices.push(m));
    return { written, notices };
  }

  it("an anchored rewrite writes only at the anchor while it still holds the selection", async () => {
    expect(await commit("TODO\n\nTODO!\n")).toEqual({ written: "TODO\n\nDone!\n", notices: ["Rewrite applied."] });
  });

  it("an anchored rewrite whose anchor moved leaves the note unchanged and says so", async () => {
    expect(await commit("TODO\n\n!TODO\n")).toEqual({ written: "TODO\n\n!TODO\n", notices: [CHANGED_UNDER_EDIT] });
  });

  it("a whole-note plan applies through the plan", async () => {
    const prepared = planModalRewrite("A\nTODO\n", { ...second, from: 2, to: 6 });
    expect(prepared.anchor).toBeNull();
    expect(applyModalRewrite("X\nA\nTODO\n", prepared, [true])).toBe("X\nA\nDone\n");
  });
});

describe("runInlineEdit — insert mode", () => {
  it("asks for text to insert with the surrounding context and writes only on Accept", async () => {
    const h = harness({ reply: "```\nTest it\n```", accept: null });
    expect(await runInlineEdit({ doc: DOC, from: AT, to: AT }, h.deps)).toBe("rejected");
    expect(h.prompt.opts).toMatchObject({ mode: "insert", from: AT, to: AT });
    expect(h.requests[0]).toMatchObject({ system: INSERT_SYSTEM, maxTokens: 2000, temperature: 0.3 });
    expect(h.requests[0]!.user).toContain("<before_cursor>\n# Plan\n\nCreate the parser\n\n</before_cursor>");
    expect(h.requests[0]!.user).toContain("<after_cursor>\nShip it\n\n</after_cursor>");
    expect(h.sessions[0]!.hunks).toEqual([{ index: 0, from: AT, to: AT, oldText: "", newText: "Test it", status: "pending" }]);
    expect(h.doc.value).toBe(DOC);
  });

  it("accepting the insertion writes it at the cursor", async () => {
    const h = harness({ reply: "Test it\n" });
    expect(await runInlineEdit({ doc: DOC, from: AT, to: AT }, h.deps)).toBe("applied");
    expect(h.doc.value).toBe("# Plan\n\nCreate the parser\nTest itShip it\n");
  });

  it("with inline diff off, shows the notice and runs nothing", async () => {
    const h = harness({ inlineDiff: false });
    expect(await runInlineEdit({ doc: DOC, from: AT, to: AT }, h.deps)).toBe("skipped");
    expect(h.notices).toEqual(["Turn on inline diff review to write at the cursor."]);
    expect(h.prompt.opts).toBeNull();
    expect(h.requests).toHaveLength(0);
    expect(h.modal).not.toHaveBeenCalled();
  });

  it("an empty reply shows the failure and writes nothing", async () => {
    const h = harness({ reply: "  \n" });
    expect(await runInlineEdit({ doc: DOC, from: AT, to: AT }, h.deps)).toBe("failed");
    expect(h.sessions).toHaveLength(0);
    expect(h.notices[0]).toMatch(/^Edit failed — The model returned nothing to insert/);
    expect(h.prompt.abort.signal.aborted).toBe(false);
  });

  it("an unchanged rewrite reply shows the failure and writes nothing", async () => {
    const h = harness({ reply: "Create the parser" });
    expect(await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps)).toBe("failed");
    expect(h.sessions).toHaveLength(0);
    expect(h.notices).toEqual(["Edit failed — The model returned the text unchanged."]);
    expect(h.doc.value).toBe(DOC);
  });
});

describe("runInlineEdit — closing, aborting, staleness", () => {
  it("closing the prompt without an instruction sends nothing", async () => {
    const h = harness({ instruction: null });
    expect(await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps)).toBe("closed");
    expect(h.requests).toHaveLength(0);
  });

  it("Esc while running: the router rejects on abort though the provider ignores it; nothing is shown or written", async () => {
    const router = new ProviderRouter({ ...DEFAULT_SETTINGS, apiKey: "sk-ant-api-test" });
    const stream = vi.spyOn(router.anthropic, "stream").mockImplementation(() => new Promise<void>(() => undefined));
    vi.spyOn(router.anthropic, "complete").mockImplementation(() => new Promise<string>(() => undefined));
    const h = harness();
    h.deps.complete = async (req) => {
      h.requests.push(req);
      return (await router.complete("chat", req)).text;
    };
    const run = runInlineEdit({ doc: DOC, from: AT, to: AT }, h.deps);
    await vi.waitFor(() => expect(stream).toHaveBeenCalled(), { timeout: 500 });
    h.prompt.escape();
    expect(await run).toBe("aborted");
    expect(h.sessions).toHaveLength(0);
    expect(h.notices).toEqual([]);
    expect(h.doc.value).toBe(DOC);
  });

  it("a late reply after an abort is dropped", async () => {
    const h = harness({
      reply: async () => {
        h.prompt.escape();
        return "late text";
      },
    });
    expect(await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps)).toBe("aborted");
    expect(h.sessions).toHaveLength(0);
    expect(h.modal).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
  });

  it("a result for a range that changed while running is not shown", async () => {
    const h = harness({ range: null });
    expect(await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps)).toBe("stale");
    expect(h.notices).toEqual(["The note changed under the edit; nothing was applied."]);
    expect(h.sessions).toHaveLength(0);
    expect(h.modal).not.toHaveBeenCalled();
    expect(h.prompt.closed).toBe(1);
  });

  it("a provider failure closes the prompt and reports", async () => {
    const h = harness({ reply: new Error("boom") });
    expect(await runInlineEdit({ doc: DOC, from: SEL_FROM, to: SEL_TO }, h.deps)).toBe("failed");
    expect(h.prompt.closed).toBe(1);
    expect(h.notices).toEqual(["Edit failed — boom"]);
  });
});
