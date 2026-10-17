import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const DISTILL_REPLY = JSON.stringify({
  title: "Launch plan",
  summary: "Agreed the launch sequence.",
  decisions: ["Ship on Friday"],
  facts: [],
  openItems: [],
});
const DISTILL_RULE = { match: "Summarize the conversation for a personal knowledge base", replies: [DISTILL_REPLY] };
const SECRET = `sk-ant-api03-${"a".repeat(40)}`;

interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  toolTrace?: Array<{ name: string; argsSummary: string; resultPreview: string; ok: boolean }>;
}

async function seedConversation(page: Page, messages: SeedMessage[]): Promise<void> {
  await page.evaluate(async (seed) => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, {
      conversations(): {
        beginTurn(id: string | null, messages: unknown[], input: { backend: string; model: string; mode: string }): Promise<{ conversationId: string; turnId: string }>;
        completeTurn(id: string, turnId: string, messages: unknown[]): Promise<void>;
      };
    }> } } }).app;
    const plugin = app.plugins.plugins["claude-companion"]!;
    const turn = await plugin.conversations().beginTurn(null, seed.slice(0, 1), { backend: "anthropic", model: "stub", mode: "ask" });
    await plugin.conversations().completeTurn(turn.conversationId, turn.turnId, seed);
  }, messages);
}

async function openChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
}

async function openDropdown(page: Page) {
  await page.locator('[aria-label="Resume a past conversation"]:visible').first().click();
  const dropdown = page.locator(".cc-session-dropdown");
  await expect(dropdown).toBeVisible();
  return dropdown;
}

async function chooseRowAction(page: Page, action: RegExp): Promise<void> {
  // macOS defaults to native (OS-drawn) menus, which have no DOM to click.
  await page.evaluate(() => {
    const app = (window as unknown as { app: { vault: { setConfig(key: string, value: unknown): void } } }).app;
    app.vault.setConfig("nativeMenus", false);
  });
  await page.locator(".cc-session-row").first().locator(".cc-session-more").click();
  await page.locator(".menu .menu-item-title", { hasText: action }).click();
}

const BASIC: SeedMessage[] = [
  { role: "user", content: "first question about the launch" },
  { role: "assistant", content: "first answer about the launch" },
];

test("switching conversations preserves their separate drafts and sending clears only its owner", async ({ rig }) => {
  const a = "Summarize the pilot findings.";
  const b = "Review the release checklist.";
  const draftA = "Explain the pilot's limitations.";
  const draftB = "Confirm the release owner and deadline.";
  const newDraft = "Start an independent question.";
  const answer = "The owner and deadline should be confirmed.";
  const { page } = await rig.reset({ providerReply: [{ match: "/./", replies: [answer] }] });
  await seedConversation(page, [{ role: "user", content: a }, { role: "assistant", content: "Pilot answer." }]);
  await seedConversation(page, [{ role: "user", content: b }, { role: "assistant", content: "Release answer." }]);
  await openChat(page);
  const chat = page.locator(".cc-chat-root");
  const input = chat.locator("textarea");
  const select = async (title: string) => {
    // Completion notices overlap the history button and pause dismissal on hover.
    await page.mouse.move(500, 150);
    await expect(page.locator(".notice")).toHaveCount(0);
    const dropdown = await openDropdown(page);
    await dropdown.locator(".cc-session-row").filter({ hasText: title }).click();
  };

  await input.fill(draftB);
  await select(a);
  await expect(input).toHaveValue("");
  await input.fill(draftA);
  await select(b);
  await expect(input).toHaveValue(draftB);
  expect(await rig.providerRequests()).toBe(0);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant .cc-body").last()).toHaveText(answer);
  await expect(chat.locator(".cc-assistant").last().getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await select(a);
  await expect(input).toHaveValue(draftA);
  await select(b);
  await expect(input).toHaveValue("");

  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill(newDraft);
  await select(a);
  await expect(input).toHaveValue(draftA);
  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(input).toHaveValue(newDraft);
  await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
  await expect(chat.locator(".cc-assistant .cc-body")).toHaveText([answer]);
  await expect(chat.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(input).toHaveValue("");
  await select(a);
  await expect(input).toHaveValue(draftA);
  expect(await rig.providerRequests()).toBe(2);
});

test("the dropdown opens under the history button, narrow, inside the viewport", async ({ rig }) => {
  const { page } = await rig.reset({ providerReply: [DISTILL_RULE] });
  await seedConversation(page, BASIC);
  await openChat(page);
  const button = page.locator('[aria-label="Resume a past conversation"]:visible').first();
  const buttonBox = (await button.boundingBox())!;
  const dropdown = await openDropdown(page);
  const box = (await dropdown.boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(box.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
  expect(box.width).toBeLessThanOrEqual(420);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(dropdown).toHaveCount(0);
});

test("archiving hides the row and shows the archived count", async ({ rig }) => {
  const { page } = await rig.reset({ providerReply: [DISTILL_RULE] });
  await seedConversation(page, BASIC);
  await openChat(page);
  const dropdown = await openDropdown(page);
  await expect(dropdown.locator(".cc-session-row")).toHaveCount(1);
  await chooseRowAction(page, /^Archive$/);
  await expect(dropdown.locator(".cc-session-row")).toHaveCount(0);
  await expect(dropdown.locator(".cc-session-archive-toggle")).toHaveText("Show archived (1)");
});

test("Fork opens a second chat leaf holding the history", async ({ rig }) => {
  const { page } = await rig.reset({ providerReply: [DISTILL_RULE] });
  await seedConversation(page, BASIC);
  await openChat(page);
  await openDropdown(page);
  await chooseRowAction(page, /^Fork$/);
  await expect(page.locator(".cc-chat-root")).toHaveCount(2);
  await expect(page.locator(".cc-chat-root:visible").first()).toContainText("first question about the launch");
});

test("Distill writes a summary note without tool output or secrets", async ({ rig }) => {
  const { page } = await rig.reset({ providerReply: [DISTILL_RULE], extraFiles: { "Notes/A.md": "# A\n" } });
  await seedConversation(page, [
    { role: "user", content: `plan the launch, my key is ${SECRET}` },
    {
      role: "assistant",
      content: "Here is the plan.",
      toolTrace: [{ name: "note_read", argsSummary: "Notes/A.md", resultPreview: "TOOLNOISE-123", ok: true }],
    },
  ]);
  await openChat(page);
  await openDropdown(page);
  await chooseRowAction(page, /^Distill$/);
  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as { app: { vault: { getMarkdownFiles(): Array<{ path: string }> } } }).app;
    return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Claude/Chats/")).length;
  })).toBe(1);
  const note = await page.evaluate(async () => {
    const app = (window as unknown as { app: { vault: { getMarkdownFiles(): Array<{ path: string }>; cachedRead(file: unknown): Promise<string> } } }).app;
    const file = app.vault.getMarkdownFiles().find((f) => f.path.startsWith("Claude/Chats/"))!;
    return app.vault.cachedRead(file);
  });
  expect(note).toContain("Agreed the launch sequence.");
  expect(note).toContain("[[Notes/A]]");
  expect(note).not.toContain("TOOLNOISE-123");
  expect(note).not.toContain("sk-ant-");
});
