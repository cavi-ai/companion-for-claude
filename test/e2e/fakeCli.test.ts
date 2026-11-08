import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installFakeCli } from "../../e2e/rig/fakeCli";
import { listCodexModels } from "../../src/cli/modelDiscovery";
import { codexBackend } from "../../src/cli/backends/codex";
import { CliSession } from "../../src/cli/session";
import { mcpConfigJson } from "../../src/cli/argv";

async function reply(text: string) {
  const root = await mkdtemp(join(tmpdir(), "companion-fake-cli-"));
  try {
    const { bin } = await installFakeCli(root);
    const input = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
    const result = spawnSync(join(bin, "claude"), ["--input-format", "stream-json"], { input, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line)).find((frame) => frame.type === "result");
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe.skipIf(process.platform === "win32")("fake CLI control requests", () => {
  it("reports fixture Codex authentication through the real backend probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-fake-codex-auth-"));
    try {
      const { bin } = await installFakeCli(root);
      const auth = await codexBackend.probe(async (argv) => {
        const result = spawnSync(join(bin, "codex"), argv, { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" });
        expect(result.error).toBeUndefined();
        return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
      });
      expect(auth).toEqual({ loggedIn: true, method: "ChatGPT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs the selected Codex model through the real session parser and records its argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-fake-codex-exec-"));
    try {
      const { bin } = await installFakeCli(root);
      const session = new CliSession({
        backend: codexBackend,
        argvTemplate: { model: "e2e-codex-model", systemPromptFile: "", mcpConfigJson: mcpConfigJson(51234, "e2e-token"), allowedTools: [], maxTurns: 1, cwd: root },
        spawnTurn: (argv, env) => spawn(join(bin, "codex"), argv, { stdio: "pipe", env: { ...process.env, ...env } }),
      });
      let streamed = "";
      const result = await session.run({ system: "Fixture system prompt", model: "e2e-codex-model", maxTokens: 100, messages: [{ role: "user", content: "Use the selected Codex model." }] }, { onText: (text) => { streamed += text; } });
      expect(result.error).toBeUndefined();
      expect(result.text).toBe("pong from codex (e2e-codex-model)");
      expect(streamed).toBe("pong from codex (e2e-codex-model)");
      expect(session.sessionId()).toBe("e2e-codex-session");
      const invocations = (await readFile(join(bin, "codex-argv.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(invocations).toContainEqual({ argv: expect.arrayContaining(["exec", "--json", "-m", "e2e-codex-model", "Use the selected Codex model."]), model: "e2e-codex-model" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps Codex app-server alive through model discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-fake-codex-"));
    try {
      const { bin } = await installFakeCli(root);
      const child = spawn(join(bin, "codex"), ["app-server"], { stdio: "pipe" });
      await expect(listCodexModels(() => child)).resolves.toEqual([{ id: "e2e-codex-model", label: "E2E Codex model" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails unsupported fixture Codex commands instead of reporting a false result", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-fake-codex-unsupported-"));
    try {
      const { bin } = await installFakeCli(root);
      const result = spawnSync(join(bin, "codex"), ["unsupported-fixture-command"], { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unsupported fixture Codex command");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("answers recovery text that quotes the hanging request", async () => {
    const result = await reply("Continue unfinished work. Original task (context only):\nhang forever");
    expect(result).toMatchObject({ is_error: false, result: "pong from claude code" });
  });
  it("does not fail when a normal request quotes the failure trigger", async () => {
    expect(await reply("Explain the earlier request: make it fail")).toMatchObject({ is_error: false });
  });
  it.each(["make it fail", "please make it fail"])("retains the explicit failure control request %j", async (text) => {
    expect(await reply(text)).toMatchObject({ is_error: true, api_error_status: 404 });
  });
});
