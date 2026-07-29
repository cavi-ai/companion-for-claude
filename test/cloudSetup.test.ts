import { describe, expect, it } from "vitest";
import { dispatchSetupSteps, repliesSetupSteps, fireUrlError, cloudSetupReady } from "../src/cloud/setup";
import type { CloudDispatchConfig } from "../src/cloud/routines";
import type { RepliesConfig } from "../src/cloud/replies";

const goodDispatch: CloudDispatchConfig = {
  fireUrl: "https://api.anthropic.com/v1/claude_code/routines/abc123/fire",
  token: "sk-ant-oat-token",
  betaHeader: "experimental-cc-routine-2026-04-01",
};

const goodReplies: RepliesConfig = {
  repo: "cavi-ai/my-vault",
  branch: "main",
  folder: "Claude/Replies",
  token: "github_pat_x",
};

describe("fireUrlError", () => {
  it("accepts a well-formed routine fire endpoint", () => {
    expect(fireUrlError(goodDispatch.fireUrl)).toBeNull();
  });

  it("rejects empty, non-URL, non-https, and non-routine URLs with specific guidance", () => {
    expect(fireUrlError("")).toMatch(/no routine endpoint/i);
    expect(fireUrlError("not a url")).toMatch(/not a valid url/i);
    expect(fireUrlError("http://api.anthropic.com/v1/claude_code/routines/abc/fire")).toMatch(/https/);
    expect(fireUrlError("https://api.anthropic.com/v1/messages")).toMatch(/fire.*endpoint/i);
  });
});

describe("dispatchSetupSteps", () => {
  it("ticks every step for a complete config", () => {
    const steps = dispatchSetupSteps(goodDispatch);
    expect(steps.every((s) => s.ok)).toBe(true);
  });

  it("flags each missing piece with actionable detail", () => {
    const steps = dispatchSetupSteps({ fireUrl: "", token: "", betaHeader: "" });
    expect(steps.map((s) => s.ok)).toEqual([false, false, false]);
    expect(steps[0]?.detail).toMatch(/fire/i);
    expect(steps[1]?.detail).toMatch(/token/i);
    expect(steps[2]?.detail).toMatch(/beta/i);
  });
});

describe("repliesSetupSteps", () => {
  it("ticks every step for a complete config", () => {
    expect(repliesSetupSteps(goodReplies).every((s) => s.ok)).toBe(true);
  });

  it("flags a malformed repo and missing fields", () => {
    const steps = repliesSetupSteps({ repo: "no-slash-here", branch: "", folder: "", token: "" });
    expect(steps.map((s) => s.ok)).toEqual([false, false, false, false]);
    expect(steps[0]?.detail).toMatch(/owner\/name/i);
  });
});

describe("cloudSetupReady", () => {
  it("requires both configs valid and a routine-shaped fire URL", () => {
    expect(cloudSetupReady(goodDispatch, goodReplies)).toBe(true);
    expect(cloudSetupReady({ ...goodDispatch, fireUrl: "https://example.test/fire" }, goodReplies)).toBe(false);
    expect(cloudSetupReady({ ...goodDispatch, token: "" }, goodReplies)).toBe(false);
    expect(cloudSetupReady(goodDispatch, { ...goodReplies, repo: "bad" })).toBe(false);
  });
});
