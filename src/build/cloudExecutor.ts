import { buildFireRequest, parseFireResponse, type CloudDispatchConfig } from "../cloud/routines";
import { buildContentsRequest, parseFileResponse, type RepliesConfig } from "../cloud/replies";
import type { BuildTaskEvent, BuildTaskExecution, BuildTaskExecutionInput, BuildTaskExecutor } from "./run";

export interface CloudBuildHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface CloudBuildHttpPort {
  request(request: CloudBuildHttpRequest): Promise<{ status: number; text: string }>;
}

export interface CloudBuildExecutorOptions {
  routine: CloudDispatchConfig;
  replies: RepliesConfig;
  http: CloudBuildHttpPort;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
}

const safeSegment = (value: string): string => value
  .replace(/[^A-Za-z0-9_-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 80) || "build";

export function cloudTaskMarkerPath(folder: string, runId: string, index: number): string {
  return `${folder.replace(/\/+$/g, "")}/builds/${safeSegment(runId)}/task-${index + 1}.md`;
}

function cloudTaskPrompt(input: BuildTaskExecutionInput, markerPath: string): string {
  return [
    `Run task ${input.index + 1} of ${input.total} for Companion build ${input.runId}.`,
    `Read the build spec at ${input.specPath}.`,
    `Implement only this task: ${input.title}`,
    "Run focused verification and commit the resulting repository changes through the routine's configured workflow.",
    `When finished, write a short result note to ${markerPath}. The first line must summarize the result.`,
    "If blocked, write the exact blocker to that same marker instead of claiming completion.",
    `Do not edit ${input.trackerPath}; Companion owns tracker state.`,
  ].join("\n");
}

const abortError = (): DOMException => new DOMException("aborted", "AbortError");

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { window.clearTimeout(timer); cleanup(); reject(abortError()); };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function redact(message: string, secrets: string[]): string {
  let safe = message;
  for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join("[redacted]");
  return safe.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\btoken\s*[=:]\s*\S+/gi, "token=[redacted]");
}

export class CloudBuildExecutor implements BuildTaskExecutor {
  readonly cancelMode = "after-current" as const;
  private readonly initialPollMs: number;
  private readonly maxPollMs: number;

  constructor(private readonly options: CloudBuildExecutorOptions) {
    this.initialPollMs = Math.max(1, options.pollIntervalMs ?? 5_000);
    this.maxPollMs = Math.max(this.initialPollMs, options.maxPollIntervalMs ?? 30_000);
  }

  async execute(input: BuildTaskExecutionInput, signal: AbortSignal, emit: (event: BuildTaskEvent) => void): Promise<BuildTaskExecution> {
    const markerPath = cloudTaskMarkerPath(this.options.replies.folder, input.runId, input.index);
    let sessionId = input.sessionId;
    let sessionUrl = input.sessionUrl;
    const existing = await this.readMarker(markerPath, signal);
    if (existing !== null) return { summary: existing, ...(sessionUrl ? { sessionUrl } : {}) };

    if (!sessionId) {
      try {
        const request = buildFireRequest(this.options.routine, cloudTaskPrompt(input, markerPath));
        const response = await this.options.http.request(request);
        if (signal.aborted) throw abortError();
        const fired = parseFireResponse(response.status, response.text);
        sessionId = fired.sessionId ?? undefined;
        sessionUrl = fired.sessionUrl ?? undefined;
        emit({ type: "session", ...(sessionId ? { sessionId } : {}), ...(sessionUrl ? { sessionUrl } : {}) });
      } catch (cause) {
        if (signal.aborted) throw abortError();
        throw new Error(redact(cause instanceof Error ? cause.message : String(cause), [this.options.routine.token, this.options.replies.token]), { cause });
      }
    }

    let delay = this.initialPollMs;
    while (!signal.aborted) {
      const summary = await this.readMarker(markerPath, signal);
      if (summary !== null) return { summary, ...(sessionUrl ? { sessionUrl } : {}) };
      await wait(delay, signal);
      delay = Math.min(this.maxPollMs, delay * 2);
    }
    throw abortError();
  }

  private async readMarker(path: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) throw abortError();
    const request = buildContentsRequest(this.options.replies, path);
    const response = await this.options.http.request(request);
    if (signal.aborted) throw abortError();
    if (response.status === 404) return null;
    try {
      const file = parseFileResponse(response.status, response.text);
      return file.text.trim().slice(0, 2_000) || "Task completed.";
    } catch (cause) {
      throw new Error(redact(cause instanceof Error ? cause.message : String(cause), [this.options.routine.token, this.options.replies.token]), { cause });
    }
  }
}
