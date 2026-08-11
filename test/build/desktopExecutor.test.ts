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
  it("starts Claude Code with an argument array and stream-json output", async () => {
    const calls: Array<{ executable: string; args: string[]; options: ManagedProcessOptions }> = [];
    const port: ManagedProcessPort = {
      async run(executable, args, options) {
        calls.push({ executable, args, options });
        options.onStdout('{"type":"result","result":"Parser complete"}\n');
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
    const port: ManagedProcessPort = { run: async (_exe, next) => { args.push(next); return { code: 0, stderr: "" }; } };
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
