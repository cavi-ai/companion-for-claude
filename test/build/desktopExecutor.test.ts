import { describe, expect, it, vi } from "vitest";
import {
  DesktopBuildExecutor,
  type ManagedProcessOptions,
  type ManagedProcessPort,
} from "../../src/build/desktopExecutor";
import type { BuildTaskExecutionInput } from "../../src/build/run";

const task = (index = 0): BuildTaskExecutionInput => ({
  runId: "run 7;$HOME",
  title: index === 0 ? "Create parser" : "Wire UI",
  index,
  total: 2,
  specPath: "Claude/Builds/Plan — spec.md",
  trackerPath: "Claude/Builds/Plan — tracker.md",
  transport: "desktop",
});

describe("DesktopBuildExecutor", () => {
  it.each([
    [{ type: "result", subtype: "success", is_error: true, result: "API Error: provider unavailable" }, "provider unavailable"],
    [{ type: "result", subtype: "error_during_execution", is_error: false, result: "Execution failed" }, "Execution failed"],
    [{ type: "result", subtype: "error_max_turns", is_error: false }, "turn limit"],
  ])("rejects a structured task failure despite a zero exit code: %j", async (frame, message) => {
    const line = JSON.stringify(frame);
    const port: ManagedProcessPort = { run: async (_exe, _args, options) => {
      options.onStdout(line.slice(0, 17));
      options.onStdout(line.slice(17));
      return { code: 0, stderr: "" };
    } };
    await expect(new DesktopBuildExecutor({ process: port, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, () => {})).rejects.toThrow(message as string);
  });

  it.each(["", "not JSON\n", '{"type":"assistant","message":{"content":[{"type":"text","text":"Working"}]}}\n'])("requires a terminal result after %j", async (stdout) => {
    const port: ManagedProcessPort = { run: async (_exe, _args, options) => { options.onStdout(stdout); return { code: 0, stderr: "" }; } };
    await expect(new DesktopBuildExecutor({ process: port, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, () => {})).rejects.toThrow("without a task result");
  });

  it("retains an explicit failure even if a later success frame arrives and redacts result credentials", async () => {
    const port: ManagedProcessPort = { run: async (_exe, _args, options) => {
      options.onStdout('{"type":"result","subtype":"success","is_error":true,"result":"API failed token=private-key Bearer private-bearer"}\n');
      options.onStdout('{"type":"result","subtype":"success","is_error":false,"result":"Late success"}\n');
      return { code: 0, stderr: "" };
    } };
    const output: string[] = [];
    const result = await new DesktopBuildExecutor({ process: port, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, (line) => output.push(line)).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("API failed");
    expect((result as Error).message + output.join(" ")).not.toMatch(/private-key|private-bearer/);
  });

  it("accepts a successful result even when ordinary assistant text discusses an error", async () => {
    const port: ManagedProcessPort = { run: async (_exe, _args, options) => {
      options.onStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed the API Error handler"}]}}\n');
      options.onStdout('{"type":"result","subtype":"success","is_error":false,"result":"Handler verified"}');
      return { code: 0, stderr: "" };
    } };
    const result = await new DesktopBuildExecutor({ process: port, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, () => {});
    expect(result.summary).toBe("Handler verified");
  });

  it("starts Claude Code with an argument array and stream-json output", async () => {
    const calls: Array<{ executable: string; args: string[]; options: ManagedProcessOptions }> = [];
    const port: ManagedProcessPort = {
      async run(executable, args, options) {
        calls.push({ executable, args, options });
        options.onStdout('{"type":"result","subtype":"success","is_error":false,"result":"Parser complete"}\n');
        return { code: 0, stderr: "" };
      },
    };
    const output: string[] = [];
    const executor = new DesktopBuildExecutor({ process: port, executable: "/opt/claude", cwd: "/vault" });
    const result = await executor.execute(task(), new AbortController().signal, (line) => output.push(line));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe("/opt/claude");
    expect(calls[0]!.options.cwd).toBe("/vault");
    expect(calls[0]!.args.slice(0, 2)).toEqual(["-p", expect.stringContaining("Create parser")]);
    expect(calls[0]!.args).toContain("stream-json");
    expect(calls[0]!.args).toContain("--verbose");
    expect(calls[0]!.args).toContain("--name");
    expect(calls[0]!.args.join(" ")).not.toContain("claude -p");
    expect(result.summary).toBe("Parser complete");
    expect(output).toEqual(["Parser complete"]);
  });

  it("resumes the stable named session for later tasks", async () => {
    const args: string[][] = [];
    const port: ManagedProcessPort = { run: async (_exe, next, options) => { args.push(next); options.onStdout('{"type":"result","subtype":"success","is_error":false}\n'); return { code: 0, stderr: "" }; } };
    const executor = new DesktopBuildExecutor({ process: port, executable: "claude", cwd: "/vault" });
    await executor.execute(task(1), new AbortController().signal, () => {});
    expect(args[0]).toContain("--resume");
    expect(args[0]).not.toContain("--name");
    const resumeIndex = args[0]!.indexOf("--resume");
    expect(args[0]![resumeIndex + 1]).toBe("companion-build-run-7-HOME");
  });

  it("passes cancellation through and never leaks secrets from stderr", async () => {
    let receivedSignal: AbortSignal | undefined;
    const port: ManagedProcessPort = {
      run: async (_exe, _args, options) => {
        receivedSignal = options.signal;
        return await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      },
    };
    const controller = new AbortController();
    const executor = new DesktopBuildExecutor({ process: port, executable: "claude", cwd: "/vault" });
    const pending = executor.execute(task(), controller.signal, () => {});
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("maps missing CLI, authentication, and non-zero exits to actionable errors", async () => {
    const missing: ManagedProcessPort = { run: vi.fn(async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); }) };
    await expect(new DesktopBuildExecutor({ process: missing, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, () => {}))
      .rejects.toThrow("Desktop integrations");

    const unauthorized: ManagedProcessPort = { run: async () => ({ code: 1, stderr: "401 token=super-secret authentication required" }) };
    await expect(new DesktopBuildExecutor({ process: unauthorized, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, () => {}))
      .rejects.toThrow("Claude Code authentication failed");
    await expect(new DesktopBuildExecutor({ process: unauthorized, executable: "claude", cwd: "/vault" })
      .execute(task(), new AbortController().signal, () => {}))
      .rejects.not.toThrow("super-secret");
  });
});
