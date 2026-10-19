import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installFakeCli } from "../../e2e/rig/fakeCli";

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
