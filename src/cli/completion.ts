// One-shot buffered completion over a CLI backend: tool-less, MCP-less, single turn. Pure: spawn and prompt-file IO are injected.

import type { CompletionRequest } from "../providers/types";
import { StreamJsonParser } from "./streamJson";
import { plainUserMessageText, userMessageLine, type CliChild } from "./session";
import type { CliBackend } from "./backends/types";

export interface CliCompletionDeps {
  backend: CliBackend;
  spawn: (argv: string[], env?: Record<string, string>) => CliChild;
  writeSystemPromptFile?: (text: string) => Promise<string>;
  removeFile?: (path: string) => Promise<void>;
  idleAbortMs?: number;
}

const STDERR_TAIL = 500;
const KILL_GRACE_MS = 1500;
const IDLE_ABORT_MS = 180_000;

function cancelled(): Error {
  const err = new Error("Cancelled");
  err.name = "AbortError";
  return err;
}

export async function runCliCompletion(deps: CliCompletionDeps, req: CompletionRequest, cwd: string, onText?: (delta: string) => void): Promise<string> {
  const { backend } = deps;
  if (req.signal?.aborted) throw cancelled();
  let promptFile: string | undefined;
  try {
    let argv: string[];
    if (backend.processModel === "persistent") {
      if (!deps.writeSystemPromptFile) throw new Error("writeSystemPromptFile is required for this backend");
      promptFile = await deps.writeSystemPromptFile(req.system);
      argv = backend.buildCompletionArgv({ model: req.model, cwd, systemPromptFile: promptFile });
    } else {
      argv = backend.buildCompletionArgv({ model: req.model, cwd, message: plainUserMessageText(req), systemPromptText: req.system });
    }
    if (req.signal?.aborted) throw cancelled();
    return await converse(deps, req, deps.spawn(argv), onText);
  } finally {
    if (promptFile !== undefined) await deps.removeFile?.(promptFile);
  }
}

function converse(deps: CliCompletionDeps, req: CompletionRequest, child: CliChild, onText?: (delta: string) => void): Promise<string> {
  const { backend } = deps;
  const idleMs = deps.idleAbortMs ?? IDLE_ABORT_MS;
  return new Promise<string>((resolve, reject) => {
    const parser = new StreamJsonParser((line) => backend.parseLine(line));
    let text = "";
    let stderr = "";
    let settled = false;
    let idleTimer: number | undefined;
    let killTimer: number | undefined;
    let exited = false;

    const cleanup = (): void => {
      if (idleTimer) window.clearTimeout(idleTimer);
      req.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
      killTimer = window.setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const armIdle = (): void => {
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => settle(() => {
        terminate();
        reject(new Error(`${backend.label} produced no output for ${Math.round(idleMs / 1000)} s.`));
      }), idleMs);
    };
    function onAbort(): void {
      settle(() => {
        terminate();
        reject(cancelled());
      });
    }
    const handle = (events: ReturnType<StreamJsonParser["push"]>): void => {
      for (const ev of events) {
        if (ev.kind === "text") {
          text += ev.delta;
          onText?.(ev.delta);
        } else if (ev.kind === "result") {
          if (ev.isError) settle(() => reject(new Error(ev.text || ev.subtype)));
          else settle(() => resolve(text.length > 0 ? text : ev.text));
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      armIdle();
      handle(parser.push(String(chunk)));
    });
    child.stderr.on("data", (chunk) => {
      armIdle();
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
    });
    child.on("error", (err) => settle(() => reject(new Error(`${backend.label} failed to start: ${err.message}`))));
    child.on("exit", (code) => {
      exited = true;
      if (killTimer) window.clearTimeout(killTimer);
      handle(parser.flush());
      if (settled) return;
      if (code === 0 && backend.processModel === "per-turn") settle(() => resolve(text));
      else settle(() => reject(new Error(`${backend.label} exited (code ${code ?? "null"}). ${stderr.trim()}`.trim())));
    });
    req.signal?.addEventListener("abort", onAbort);
    armIdle();

    if (backend.processModel === "persistent") {
      child.stdin.write(userMessageLine(req, null));
    }
    child.stdin.end();
  });
}
