import type { BuildTaskEvent, BuildTaskExecution, BuildTaskExecutionInput, BuildTaskExecutor } from "./run";

export interface ManagedProcessOptions {
  cwd: string;
  signal: AbortSignal;
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
}

export interface ManagedProcessResult {
  code: number;
  stderr: string;
}

export interface ManagedProcessPort {
  run(executable: string, args: string[], options: ManagedProcessOptions): Promise<ManagedProcessResult>;
}

export interface DesktopBuildExecutorOptions {
  process: ManagedProcessPort;
  executable: string;
  cwd: string;
}

const buildSessionName = (runId: string): string => {
  const safe = runId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
  return `companion-build-${safe}`;
};

const taskPrompt = (input: BuildTaskExecutionInput): string => [
  `You are running task ${input.index + 1} of ${input.total} for a Companion for Claude build.`,
  `Build spec: ${input.specPath}`,
  `Current task: ${input.title}`,
  "Implement only this task. Inspect the repository, make the required changes, and run focused verification.",
  "Do not modify the build tracker; Companion records task progress itself.",
  "Finish with a short plain-language result summary. If blocked, explain the exact blocker and do not claim success.",
].join("\n");

const sanitize = (value: string): string => value
  .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
  .replace(/\b(?:api[_-]?key|token|password)\s*[=:]\s*\S+/gi, "$1=[redacted]")
  .replace(/[\r\t]+/g, " ")
  .trim();

function outputText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof value.result === "string") return sanitize(value.result);
    const message = value.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = message?.content?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
    return text ? sanitize(text) : null;
  } catch {
    return null;
  }
}

function executionError(cause: unknown): Error {
  if (cause instanceof DOMException && cause.name === "AbortError") return cause;
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (code === "ENOENT" || /\bENOENT\b|not found/i.test(cause instanceof Error ? cause.message : String(cause))) {
    return new Error("Claude Code was not found. Open Companion → Desktop integrations, then install or reconnect Claude Code.");
  }
  return new Error(`Claude Code could not start: ${sanitize(cause instanceof Error ? cause.message : String(cause))}`);
}

export class DesktopBuildExecutor implements BuildTaskExecutor {
  readonly cancelMode = "immediate" as const;

  constructor(private readonly options: DesktopBuildExecutorOptions) {}

  async execute(input: BuildTaskExecutionInput, signal: AbortSignal, emit: (event: BuildTaskEvent) => void): Promise<BuildTaskExecution> {
    const session = buildSessionName(input.runId);
    const args = ["-p", taskPrompt(input), "--output-format", "stream-json", "--verbose"];
    if (input.index === 0) args.push("--name", session);
    else args.push("--resume", session);

    let stdoutBuffer = "";
    let stderr = "";
    let summary: string | undefined;
    const consume = (chunk: string): void => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const text = outputText(line);
        if (text) { summary = text; emit(text); }
      }
    };

    let result: ManagedProcessResult;
    try {
      result = await this.options.process.run(this.options.executable, args, {
        cwd: this.options.cwd,
        signal,
        onStdout: consume,
        onStderr: (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); },
      });
    } catch (cause) {
      throw executionError(cause);
    }
    const tail = outputText(stdoutBuffer);
    if (tail) { summary = tail; emit(tail); }
    const safeError = sanitize(result.stderr || stderr);
    if (result.code !== 0) {
      if (/\b401\b|unauthori[sz]ed|authentication|not logged in/i.test(safeError)) {
        throw new Error("Claude Code authentication failed. Open a terminal, run `claude`, sign in, then Retry in Companion.");
      }
      throw new Error(`Claude Code exited with status ${result.code}${safeError ? `: ${safeError}` : "."}`);
    }
    return { ...(summary ? { summary } : {}) };
  }
}
