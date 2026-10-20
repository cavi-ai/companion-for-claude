import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import type { Rig } from "./fixtures";
import { PLUGIN_ROOT } from "./rig/client.ts";

test.describe.configure({ mode: "serial" });
let harness: Rig;
let port = 0;

const MCPEVAL = join(PLUGIN_ROOT, "node_modules", ".bin", "mcpeval");
const BASELINE = join(PLUGIN_ROOT, "e2e", "mcp-eval.baseline.json");

interface Report {
  readiness: { score: number; standard: string; areas: { name: string; score: number; checks: { id: string; tool: string | null; reason: string }[] }[] };
}

/** Score plus every lost check; tool descriptions and measurements may change without moving either. */
function readiness(report: Report) {
  return {
    standard: report.readiness.standard,
    score: report.readiness.score,
    lost: report.readiness.areas.flatMap((area) => area.checks.map((check) => `${area.name} ${check.id} ${check.tool ?? "-"} ${check.reason}`)).sort(),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return reject(new Error("No port")); s.close(() => resolve(a.port)); });
  });
}

function mcpeval(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(MCPEVAL, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test.beforeAll(async ({ rig }) => {
  port = await freePort();
  harness = await rig.reset({
    embedStub: true,
    settingsOverride: { mcpEnabled: true, mcpPort: port, mcpAllowWrites: false, mcpToken: "8d2e4f6a1b3c5d7e9f0a2b4c6d8e0f13" },
    extraFiles: {
      "Notes/Pelican.md": "---\ntags: [birds]\n---\n# Pelican\nPelicans fish in groups. See [[Notes/Heron]].",
      "Notes/Heron.md": "---\ntags: [birds]\n---\n# Heron\nHerons hunt alone.",
    },
  });
});
test.afterAll(async () => { await harness?.close(); });

test("the read-only MCP bridge holds its mcp-eval readiness baseline", async () => {
  test.setTimeout(300_000);
  const bearer = await harness.page.evaluate(async () => {
    const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { syncMcpServer(): Promise<void>; semantic(): { rebuildSemanticIndex(): Promise<void> }; resolvedMcpToken(): string }> } } }).app.plugins.plugins["claude-companion"];
    await plugin.syncMcpServer();
    await plugin.semantic().rebuildSemanticIndex();
    return plugin.resolvedMcpToken();
  });

  const env = { ...process.env, MCPEVAL_HOME: test.info().outputPath("mcpeval-home"), MCPEVAL_HTTP_AUTHORIZATION: `Bearer ${bearer}` };
  const run = await mcpeval(["score", "--server", "claude-companion", "--url", `http://127.0.0.1:${port}/mcp`, "--format", "json"], env);
  const reportPath = test.info().outputPath("mcpeval.report.json");
  await writeFile(reportPath, run.stdout);
  await test.info().attach("mcpeval.report.json", { path: reportPath, contentType: "application/json" });
  expect(run.code, run.stderr).toBe(0);

  // The report is deterministic: any change in score or lost checks must land with a regenerated baseline.
  const current = JSON.parse(run.stdout) as Report;
  const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Report;
  expect(readiness(current), `mcpeval report: ${reportPath}`).toEqual(readiness(baseline));
});
