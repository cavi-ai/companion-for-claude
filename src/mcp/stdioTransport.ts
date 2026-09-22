// stdio MCP transport: spawn a local server process and speak newline-delimited
// JSON-RPC over its stdin/stdout. Desktop only — Obsidian's Electron renderer
// exposes Node, mobile does not. Like mcp/server.ts, child_process types are
// inline import() references and the runtime module comes from window.require,
// so this file loads safely on mobile (only ever called behind a desktop gate).

import type { JsonRpcResponse } from "./protocol";
import type { McpTransport } from "./client";

type ChildProcess = import("node:child_process").ChildProcessWithoutNullStreams;

/**
 * A stdio server that accepts a request but never replies must not wedge the
 * agent turn forever. 60s is generous for a local process while still bounded.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export async function createStdioMcpTransport(command: string, args: string[]): Promise<McpTransport> {
  const { spawn } = (window as { require: (m: string) => typeof import("node:child_process") }).require("child_process");
  const child: ChildProcess = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

  let buffer = "";
  let stderrTail = "";
  const pending = new Map<string | number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: number }>();

  const failAll = (message: string): void => {
    for (const { reject, timer } of pending.values()) {
      window.clearTimeout(timer);
      reject(new Error(message));
    }
    pending.clear();
  };

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-500);
  });
  child.on("error", (err) => failAll(`MCP server process failed: ${err.message}`));
  child.on("exit", (code) => {
    if (pending.size > 0) failAll(`MCP server exited (code ${code ?? "?"}).${stderrTail.trim() ? ` ${stderrTail.trim()}` : ""}`);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch (e) {
        console.debug("Claude Companion: stdio transport JSON parse failed", e);
        continue; // server logs on stdout are not protocol messages
      }
      if (message.id === undefined || message.id === null) continue; // server notification
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        window.clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });

  return {
    send(message) {
      return new Promise<JsonRpcResponse | null>((resolve, reject) => {
        if (message.id !== undefined && message.id !== null) {
          const timer = window.setTimeout(() => {
            pending.delete(message.id!);
            reject(new Error(`MCP server did not reply to ${String(message.method)} within ${REQUEST_TIMEOUT_MS / 1000}s.`));
          }, REQUEST_TIMEOUT_MS);
          pending.set(message.id, { resolve, reject, timer });
        } else {
          resolve(null);
        }
        child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
          if (err) {
            if (message.id !== undefined && message.id !== null) {
              const waiter = pending.get(message.id);
              if (waiter) window.clearTimeout(waiter.timer);
              pending.delete(message.id);
            }
            reject(err);
          }
        });
      });
    },
    async close() {
      // Settle in-flight requests so a caller awaiting a reply isn't left hanging
      // when a settings change (or unload) tears the session down mid-call.
      failAll("MCP server connection closed.");
      child.kill();
    },
  };
}
