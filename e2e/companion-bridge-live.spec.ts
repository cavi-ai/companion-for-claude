import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";

// Real Claude Code, real subscription: opt in with CC_E2E_LIVE=1. Never runs in CI.
const LIVE = process.env.CC_E2E_LIVE === "1";
const CLAUDE = join(homedir(), ".local", "bin", "claude");
const run = promisify(execFile);

// This worktree's sibling checkout of the obsidian-agent submodule.
const CLAUDE_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "claude-plugin");
const TOKEN = "cbl9f3a1e7d2c4b6a8f0e1d2c3b4a5f69";

async function claudeSignedIn(): Promise<boolean> {
  try {
    const { stdout } = await run(CLAUDE, ["auth", "status"], { timeout: 10_000 });
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return reject(new Error("No port")); s.close(() => resolve(a.port)); });
  });
}

interface StreamEvent {
  type?: string;
  message?: { content?: Array<{ type?: string; name?: string }> };
}

test.describe("obsidian-agent connection-finder over Companion's bridge, live", () => {
  test.skip(!LIVE, "set CC_E2E_LIVE=1 to run against the signed-in claude binary");

  test("connection-finder calls the obsidian-vault MCP bridge's related_notes tool", async ({ rig }) => {
    test.setTimeout(300_000);
    test.skip(!(await claudeSignedIn()), "claude auth status is not loggedIn");

    const port = await freePort();
    const harness = await rig.reset({
      embedStub: true,
      settingsOverride: { mcpEnabled: true, mcpPort: port, mcpAllowWrites: false, mcpToken: TOKEN },
      extraFiles: {
        "Topics/Keeper.md": "The lighthouse keeper maintains the beacon lamp through the night watch.",
        "Topics/Beacon.md": "A beacon signals passing ships through fog near the old lighthouse.",
        "Topics/Fog.md": "Thick fog rolls over the harbor where the lighthouse still stands.",
        "Topics/Harbor.md": "The harbor pilot guides ships past the lighthouse when fog sets in.",
        "Topics/Ships.md": "Ships navigate by the lighthouse beacon through the fog at night.",
        "Topics/Sourdough.md": "A sourdough starter needs flour and water fed on a daily schedule.",
      },
    });

    let outLog = "";
    let toolNames: string[] = [];
    let liveError: string | undefined;
    try {
      // Start the bridge and build the embedding index the stub backs, like substrate-bridge.spec.ts.
      await harness.page.evaluate(async () => {
        const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { syncMcpServer(): Promise<void>; rebuildSemanticIndex(): Promise<void> }> } } }).app.plugins.plugins["claude-companion"];
        await plugin.syncMcpServer();
        await plugin.rebuildSemanticIndex();
      });

      const mcpConfig = JSON.stringify({
        mcpServers: {
          "obsidian-vault": {
            type: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { Authorization: `Bearer ${TOKEN}` },
          },
        },
      });

      const prompt = "/obsidian-agent:connection-finder Topics/Keeper.md in vault e2e. "
        + "Only the obsidian-vault MCP bridge tools are available in this session (no Obsidian CLI, no Bash); "
        + "follow the skill's \"Companion bridge (optional)\" section and call related_notes to cast the wide net.";

      const args = [
        "-p", prompt,
        "--plugin-dir", CLAUDE_PLUGIN_DIR,
        "--strict-mcp-config",
        "--mcp-config", mcpConfig,
        "--setting-sources", "",
        "--output-format", "stream-json",
        "--verbose",
        "--model", "claude-sonnet-5",
        "--allowedTools", "mcp__obsidian-vault__related_notes,mcp__obsidian-vault__note_read,mcp__obsidian-vault__vault_search",
      ];

      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(CLAUDE, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude did not exit within 5 minutes. stderr:\n${stderr}`)); }, 300_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });

      outLog = result.stdout;
      const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "phase-a", "live.jsonl");
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, outLog);

      for (const line of outLog.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: StreamEvent;
        try { event = JSON.parse(trimmed) as StreamEvent; } catch { continue; }
        if (event.type !== "assistant") continue;
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use" && block.name) toolNames.push(block.name);
        }
      }

      if (result.code !== 0 && toolNames.length === 0) {
        liveError = `claude exited ${result.code}. stderr:\n${result.stderr}`;
      }
    } finally {
      await harness.close();
    }

    if (liveError) throw new Error(liveError);

    expect(toolNames, `tool_use names seen: ${JSON.stringify(toolNames)}`).toContain("mcp__obsidian-vault__related_notes");
  });
});
