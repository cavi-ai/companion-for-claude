import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

// Real Claude Code, real subscription: opt in with CC_E2E_LIVE=1. Never runs in CI.
const LIVE = process.env.CC_E2E_LIVE === "1";
const CLAUDE = join(homedir(), ".local", "bin", "claude");
const run = promisify(execFile);

async function claudeSignedIn(): Promise<boolean> {
  try {
    const { stdout } = await run(CLAUDE, ["auth", "status"], { timeout: 10_000 });
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

const openChat = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
};

const send = async (page: Page, text: string): Promise<void> => {
  const input = page.locator(".cc-chat-root .cc-input").first();
  await input.fill(text);
  await input.press("Enter");
};

const lastReply = (page: Page) => page.locator(".cc-msg.cc-assistant").last();

// A turn is over when the send control stops offering to abort it.
const waitIdle = async (page: Page): Promise<void> => {
  await expect(page.locator(".cc-send")).toHaveAttribute("aria-label", "Send message", { timeout: 180_000 });
};

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

// data.json is rewritten non-atomically at turn end; read until it parses.
const readData = async (path: string): Promise<string> => {
  let last = "";
  await expect.poll(async () => {
    last = await readFile(path, "utf8").catch(() => "");
    try { JSON.parse(last); return true; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  return last;
};

test.describe("Claude Code backend, live", () => {
  test.skip(!LIVE, "set CC_E2E_LIVE=1 to run against the signed-in claude binary");

  test("the real-run gate: stream, read, gated write, diffed edit, patch, secrets, abort, restart, session id", async () => {
    // 9 model turns; budget generously for live latency.
    test.setTimeout(900_000);
    test.skip(!(await claudeSignedIn()), "claude auth status is not loggedIn");
    const harness = await launchObsidianHarness({ liveClaude: true });
    const { vault } = harness.paths;
    const dataPath = join(vault, ".obsidian", "plugins", "claude-companion", "data.json");
    let kept = false;
    try {
      const { page } = harness;
      await openChat(page);
      const chat = page.locator(".cc-chat-root").first();
      await expect(chat).toContainText("● Claude Code", { timeout: 20_000 });

      // stream
      await send(page, "Reply with exactly: pong");
      await expect(lastReply(page)).toContainText("pong", { timeout: 180_000 });
      await waitIdle(page);

      // read chip
      await send(page, 'Call the vault_search tool with the query "Continuity" and list the note titles it returns.');
      const chip = page.locator(".cc-tool-chip").filter({ hasText: "vault_search" }).first();
      await expect(chip).toBeVisible({ timeout: 180_000 });
      await expect(chip).not.toHaveClass(/is-running/, { timeout: 180_000 });
      await waitIdle(page);
      await expect(lastReply(page)).toContainText(/continuity/i);

      // write → deny
      const confirm = page.locator(".modal-container").filter({ hasText: "Claude wants to modify your vault" });
      await send(page, 'Call the note_create tool to create a note at the path "Live/Hello.md" with the body "hello". Do not ask for confirmation in text; just call the tool.');
      await expect(confirm).toBeVisible({ timeout: 180_000 });
      await confirm.getByRole("button", { name: "Deny", exact: true }).click();
      await waitIdle(page);
      await expect(lastReply(page)).toContainText(/declin|denied|not allowed|permission|rejected/i);
      expect(await exists(join(vault, "Live", "Hello.md"))).toBe(false);

      // write → allow
      await send(page, 'Call note_create again for "Live/Hello.md" with the body "hello".');
      await expect(confirm).toBeVisible({ timeout: 180_000 });
      await confirm.getByRole("button", { name: "Allow", exact: true }).click();
      await waitIdle(page);
      await expect.poll(() => readFile(join(vault, "Live", "Hello.md"), "utf8").catch(() => ""), { timeout: 30_000 }).toContain("hello");

      // inline edit on an open note
      await page.evaluate(async () => {
        const app = (window as unknown as { app: { workspace: { openLinkText(link: string, source: string, newLeaf: boolean): Promise<void> } } }).app;
        await app.workspace.openLinkText("Build plan", "", false);
      });
      await send(page, 'Call propose_note_edit on "Build plan.md" replacing the exact text "Create the parser" with "Create the tokenizer".');
      // The note is open, so the proposal reviews inline; accepting edits the live buffer.
      await expect(page.locator(".cc-inline-add")).toBeVisible({ timeout: 180_000 });
      await page.locator(".cc-inline-btn.is-accept").first().click();
      await waitIdle(page);
      await expect.poll(() => readFile(join(vault, "Build plan.md"), "utf8"), { timeout: 30_000 }).toContain("Create the tokenizer");

      // secrets never land in data.json
      expect(await readData(dataPath)).not.toContain("sk-ant");

      // note_patch reaches the bridge and asks for confirmation like every write
      await send(page, 'Call note_patch on "Build plan.md" with target {"kind":"heading","heading":"Build plan"}, op "append", content "- [ ] Write the tests".');
      await expect(confirm).toBeVisible({ timeout: 180_000 });
      await confirm.getByRole("button", { name: "Allow", exact: true }).click();
      await waitIdle(page);
      await expect.poll(() => readFile(join(vault, "Build plan.md"), "utf8"), { timeout: 30_000 }).toContain("- [ ] Write the tests");

      // abort mid-stream, then the next send works
      await send(page, "Count from 1 to 500, one number per line, nothing else.");
      await expect(page.locator(".cc-send")).toHaveAttribute("aria-label", "Stop generating", { timeout: 60_000 });
      await expect(lastReply(page)).toContainText("1", { timeout: 120_000 });
      await page.locator(".cc-send").click();
      await waitIdle(page);
      await send(page, "Reply with exactly: pong");
      await expect(lastReply(page)).toContainText("pong", { timeout: 180_000 });
      await waitIdle(page);

      // the minted session id is on disk and hidden from memory import
      let sessionId: string | undefined;
      await expect.poll(async () => {
        sessionId = /"cliSessionId":\s*"([0-9a-f-]{36})"/.exec(await readData(dataPath))?.[1];
        return sessionId;
      }, { timeout: 15_000 }).toBeTruthy();
      expect(sessionId, "cliSessionId persisted with the conversation").toBeTruthy();
      const projects = join(homedir(), ".claude", "projects");
      const dirs = await readdir(projects);
      const onDisk = (await Promise.all(dirs.map((d) => exists(join(projects, d, `${sessionId}.jsonl`))))).some(Boolean);
      expect(onDisk, `${sessionId}.jsonl under ~/.claude/projects`).toBe(true);
      const listed = await page.evaluate(async (id) => {
        const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { listVaultSessions(): Promise<{ sessionId?: string }[]> }> } } }).app.plugins.plugins["claude-companion"];
        const sessions = await plugin.listVaultSessions();
        return sessions.some((s) => s.sessionId === id);
      }, sessionId);
      expect(listed, "memory import excludes the chat's own session").toBe(false);

      // restart: the conversation resumes and prior turns are visible to the model
      kept = true;
      await harness.close({ keep: true });
      const again = await launchObsidianHarness({ liveClaude: true, reuse: harness.paths });
      try {
        await openChat(again.page);
        await expect(again.page.locator(".cc-msg.cc-assistant").first()).toBeVisible({ timeout: 20_000 });
        await send(again.page, "Which note did I ask you to create earlier in this conversation? Answer with its vault path only.");
        await expect(again.page.locator(".cc-msg.cc-assistant").last()).toContainText("Live/Hello.md", { timeout: 180_000 });
      } finally {
        await again.close();
      }
    } finally {
      if (!kept) await harness.close();
    }
  });
});
