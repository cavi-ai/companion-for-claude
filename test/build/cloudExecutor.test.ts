import { describe, expect, it, vi } from "vitest";
import { CloudBuildExecutor, type CloudBuildHttpPort } from "../../src/build/cloudExecutor";
import type { BuildTaskEvent, BuildTaskExecutionInput } from "../../src/build/run";

const input = (sessionId?: string): BuildTaskExecutionInput => ({
  runId: "build/alpha",
  title: "Implement mobile runner",
  index: 0,
  total: 2,
  specPath: "Claude/Builds/Alpha — spec.md",
  trackerPath: "Claude/Builds/Alpha — tracker.md",
  transport: "cloud",
  ...(sessionId ? { sessionId } : {}),
});

const config = {
  routine: { fireUrl: "https://api.anthropic.com/v1/claude_code/routines/r1/fire", token: "routine-secret", betaHeader: "beta" },
  replies: { repo: "cavi-ai/vault", branch: "main", folder: "Claude/Replies", token: "github-secret" },
};

describe("CloudBuildExecutor", () => {
  it("fires one task, persists its session event, then polls its completion marker", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    let markerReads = 0;
    const http: CloudBuildHttpPort = {
      async request(request) {
        calls.push(request);
        if (request.method === "POST") return { status: 200, text: JSON.stringify({ claude_code_session_id: "s1", claude_code_session_url: "https://claude.ai/code/s1" }) };
        markerReads += 1;
        if (markerReads < 3) return { status: 404, text: JSON.stringify({ message: "Not Found" }) };
        return { status: 200, text: JSON.stringify({ path: "marker.md", sha: "abc", encoding: "base64", content: btoa("Implemented and verified") }) };
      },
    };
    const events: BuildTaskEvent[] = [];
    const executor = new CloudBuildExecutor({ ...config, http, pollIntervalMs: 1, maxPollIntervalMs: 2 });
    const result = await executor.execute(input(), new AbortController().signal, (event) => events.push(event));

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    const fireBody = JSON.parse(calls.find((call) => call.method === "POST")!.body!) as { text: string };
    expect(fireBody.text).toContain("Implement mobile runner");
    expect(fireBody.text).toContain("Claude/Replies/builds/build-alpha/task-1.md");
    expect(events).toContainEqual({ type: "session", sessionId: "s1", sessionUrl: "https://claude.ai/code/s1" });
    expect(result).toEqual({ summary: "Implemented and verified", sessionUrl: "https://claude.ai/code/s1" });
  });

  it("resumes polling an already-dispatched task without firing it again", async () => {
    const methods: string[] = [];
    const http: CloudBuildHttpPort = { request: async (request) => { methods.push(request.method); return { status: 200, text: JSON.stringify({ path: "marker.md", sha: "abc", encoding: "base64", content: btoa("Done") }) }; } };
    const executor = new CloudBuildExecutor({ ...config, http, pollIntervalMs: 1 });
    await executor.execute(input("existing-session"), new AbortController().signal, () => {});
    expect(methods).toEqual(["GET"]);
  });

  it("stops polling promptly when Companion pauses, cancels, or unloads", async () => {
    vi.useFakeTimers();
    const http: CloudBuildHttpPort = { request: vi.fn(async () => ({ status: 404, text: "{}" })) };
    const executor = new CloudBuildExecutor({ ...config, http, pollIntervalMs: 5_000 });
    const controller = new AbortController();
    const pending = executor.execute(input("existing-session"), controller.signal, () => {});
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const count = vi.mocked(http.request).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(http.request)).toHaveBeenCalledTimes(count);
    vi.useRealTimers();
  });

  it("surfaces routine authentication failure without exposing either token", async () => {
    const http: CloudBuildHttpPort = { request: async (request) => request.method === "GET"
      ? { status: 404, text: "{}" }
      : { status: 401, text: JSON.stringify({ error: { message: "token routine-secret rejected; github-secret" } }) } };
    const executor = new CloudBuildExecutor({ ...config, http, pollIntervalMs: 1 });
    const error = await executor.execute(input(), new AbortController().signal, () => {}).catch((cause: unknown) => cause as Error);
    expect(error.message).toContain("Routine token rejected");
    expect(error.message).not.toContain("routine-secret");
    expect(error.message).not.toContain("github-secret");
  });
});
