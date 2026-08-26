import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStdioMcpTransport } from "../../src/mcp/stdioTransport";

class FakeStdin extends EventEmitter {
  writes: string[] = [];
  failWith: Error | null = null;
  write(chunk: string, cb: (err?: Error | null) => void): boolean {
    this.writes.push(chunk);
    cb(this.failWith);
    return true;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): void { this.killed = true; }
}

interface SpawnCall { command: string; args: string[]; options: { stdio: string[] } }

let child: FakeChild;
let spawned: SpawnCall[];
const host = globalThis as { require?: (m: string) => unknown };
let realRequire: ((m: string) => unknown) | undefined;

beforeEach(() => {
  child = new FakeChild();
  spawned = [];
  realRequire = host.require;
  host.require = (m: string) => {
    if (m !== "child_process") return realRequire?.(m);
    return {
      spawn: (command: string, args: string[], options: { stdio: string[] }) => {
        spawned.push({ command, args, options });
        return child;
      },
    };
  };
});

afterEach(() => {
  host.require = realRequire;
});

/** Feed a stdout chunk exactly as the child process would. */
function emit(text: string): void {
  child.stdout.emit("data", Buffer.from(text));
}

describe("createStdioMcpTransport", () => {
  it("spawns the configured command with piped stdio", async () => {
    await createStdioMcpTransport("node", ["server.js", "--flag"]);
    expect(spawned).toEqual([{ command: "node", args: ["server.js", "--flag"], options: { stdio: ["pipe", "pipe", "pipe"] } }]);
  });

  it("writes newline-delimited JSON to stdin", async () => {
    const transport = await createStdioMcpTransport("node", []);
    void transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(child.stdin.writes).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']);
  });

  it("resolves a request with the response carrying its id", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    emit('{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n');
    await expect(pending).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
  });

  it("matches responses to requests when the server answers out of order", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const first = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
    const second = transport.send({ jsonrpc: "2.0", id: 2, method: "b" });
    emit('{"jsonrpc":"2.0","id":2,"result":"second"}\n{"jsonrpc":"2.0","id":1,"result":"first"}\n');
    await expect(first).resolves.toMatchObject({ result: "first" });
    await expect(second).resolves.toMatchObject({ result: "second" });
  });

  it("resolves a notification to null without waiting for a reply", async () => {
    const transport = await createStdioMcpTransport("node", []);
    await expect(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeNull();
    expect(child.stdin.writes).toHaveLength(1);
  });

  it("reassembles a response split across chunks", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 3, method: "x" });
    emit('{"jsonrpc":"2.0",');
    emit('"id":3,"result":"ok"}');
    emit("\n");
    await expect(pending).resolves.toMatchObject({ result: "ok" });
  });

  it("ignores server logging that is not a protocol message", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 4, method: "x" });
    emit("listening on stdio\n\n");
    emit('{"jsonrpc":"2.0","id":4,"result":"ok"}\n');
    await expect(pending).resolves.toMatchObject({ result: "ok" });
  });

  it("ignores a server notification that carries no id", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 5, method: "x" });
    emit('{"jsonrpc":"2.0","method":"notifications/progress"}\n');
    emit('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse"}}\n');
    emit('{"jsonrpc":"2.0","id":5,"result":"ok"}\n');
    await expect(pending).resolves.toMatchObject({ result: "ok" });
  });

  it("rejects everything in flight when the process fails to start", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    child.emit("error", new Error("ENOENT"));
    await expect(pending).rejects.toThrow("MCP server process failed: ENOENT");
  });

  it("rejects in-flight requests on exit and reports the exit code", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    child.emit("exit", 3);
    await expect(pending).rejects.toThrow("MCP server exited (code 3).");
  });

  it("includes the tail of stderr in the exit failure", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    child.stderr.emit("data", Buffer.from("  config file not found  "));
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow("config file not found");
  });

  it("caps the stderr tail so a noisy server cannot grow the error unbounded", async () => {
    const transport = await createStdioMcpTransport("node", []);
    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    child.stderr.emit("data", Buffer.from("x".repeat(900)));
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/x{500}(?!x)/);
  });

  it("stays quiet on exit when nothing is in flight", async () => {
    await createStdioMcpTransport("node", []);
    expect(() => child.emit("exit", 0)).not.toThrow();
  });

  it("rejects and forgets a request whose write fails", async () => {
    const transport = await createStdioMcpTransport("node", []);
    child.stdin.failWith = new Error("EPIPE");
    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    await expect(pending).rejects.toThrow("EPIPE");
    expect(() => child.emit("exit", 1)).not.toThrow();
  });

  it("kills the child on close", async () => {
    const transport = await createStdioMcpTransport("node", []);
    await transport.close();
    expect(child.killed).toBe(true);
  });
});
