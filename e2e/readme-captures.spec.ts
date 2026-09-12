import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchObsidianHarness, setRightSidebarWidth, type ObsidianHarness } from "./obsidianHarness";

const ENABLED = process.env.CC_E2E_CAPTURE === "1";
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const PLUGIN_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const THEMES = (process.env.CC_E2E_CAPTURE_THEME ?? "both") === "both" ? (["dark", "light"] as const) : [process.env.CC_E2E_CAPTURE_THEME as "dark" | "light"];
const OUT_ROOT = process.env.CC_E2E_CAPTURE_DIR;
const CHAT_REPLY = "Your research draft is grounded in three reviewed evidence notes. Resolve the stale citation next, then continue drafting.";
const ORIGINAL_PLAN = "# Build plan\n\nNotes for implementation.\n\n- [ ] Create the parser\n- [ ] Wire the interface\n- [ ] Write tests\n- [ ] Ship it\n";
const ENRICHED_PLAN = "# Build Plan\n\nNotes for implementation.\n\n- [ ] Create the parser\n- [ ] Wire the interface\n- [ ] Write tests\n- [ ] Ship it to users\n";
let harness: ObsidianHarness;
let baselineSettings: Record<string, unknown>;

function outputPath(name: string, theme: "dark" | "light", assetRoot = ASSETS): string {
  return OUT_ROOT ? join(OUT_ROOT, theme, name) : join(assetRoot, name);
}

async function prepareCapture(target: Locator | Page): Promise<Page> {
  const targetPage = "page" in target && typeof (target as Locator).page === "function" ? (target as Locator).page() : (target as Page);
  await targetPage.evaluate(() => {
    document.querySelectorAll(".notice").forEach((n) => n.remove());
    // A wide row (e.g. the usage bar) can leave an ancestor mid-horizontal-scroll;
    // pin every scrollable element back to its left edge before cropping.
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (el.scrollWidth > el.clientWidth) el.scrollLeft = 0;
    });
  });
  return targetPage;
}

async function verifyCapture(path: string, name: string): Promise<void> {
  const buf = await readFile(path);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bytes = (await stat(path)).size;
  expect(width, `${name} width`).toBeLessThanOrEqual(1600);
  expect(height, `${name} height`).toBeLessThanOrEqual(1600);
  expect(bytes, `${name} bytes`).toBeLessThan(1_000_000);
}

async function shoot(target: Locator | Page, name: string, theme: "dark" | "light", assetRoot = ASSETS): Promise<void> {
  const path = outputPath(name, theme, assetRoot);
  await mkdir(dirname(path), { recursive: true });
  await prepareCapture(target);
  await target.screenshot({ path, scale: "device", animations: "disabled" });
  await verifyCapture(path, name);
}

async function shootThrough(root: Locator, end: Locator, cssHeight: number, name: string, theme: "dark" | "light", assetRoot = ASSETS): Promise<void> {
  const page = await prepareCapture(root);
  const rootBox = await root.boundingBox();
  const endBox = await end.boundingBox();
  if (!rootBox || !endBox) throw new Error(`Failed to measure ${name}`);
  expect(endBox.y + endBox.height - rootBox.y + 12, `${name} content must fit its fixed crop`).toBeLessThanOrEqual(cssHeight);

  const path = outputPath(name, theme, assetRoot);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({
    path,
    scale: "device",
    animations: "disabled",
    clip: {
      x: rootBox.x,
      y: rootBox.y,
      width: rootBox.width,
      height: cssHeight,
    },
  });
  await verifyCapture(path, name);
}

async function run(page: Page, id: string): Promise<void> {
  await page.evaluate(async (commandId) => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById(commandId);
  }, id);
}

async function openChat(harness: ObsidianHarness): Promise<Locator> {
  await run(harness.page, "claude-companion:open-chat");
  const root = harness.page.locator(".cc-chat-root");
  await expect(root).toBeVisible();
  return root;
}

async function resetScene(theme: "dark" | "light", settings: Record<string, unknown> = {}): Promise<void> {
  for (const candidate of harness.windows()) {
    for (let attempt = 0; attempt < 4 && await candidate.locator(".modal-container").count(); attempt += 1) {
      await candidate.keyboard.press("Escape");
    }
    if (candidate !== harness.page && !candidate.isClosed()) await candidate.close();
  }
  await harness.page.evaluate(async ({ nextTheme, nextSettings, defaults, originalPlan }) => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(nextTheme === "dark" ? "theme-dark" : "theme-light");
    const app = (window as unknown as {
      app: {
        plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings(): Promise<void>; startNewConversation(): Promise<void> }> };
        workspace: { getLeavesOfType(type: string): Array<{ detach(): void }> };
        vault: { getAbstractFileByPath(path: string): unknown; modify(file: unknown, data: string): Promise<void> };
      };
    }).app;
    const plugin = app.plugins.plugins["claude-companion"];
    Object.assign(plugin.settings, defaults, nextSettings);
    await plugin.saveSettings();
    await plugin.startNewConversation();
    const plan = app.vault.getAbstractFileByPath("Build plan.md");
    if (plan) await app.vault.modify(plan, originalPlan);
    for (const type of ["claude-companion-chat", "claude-research-desk", "claude-research-workbench", "markdown"]) {
      for (const leaf of app.workspace.getLeavesOfType(type)) leaf.detach();
    }
  }, { nextTheme: theme, nextSettings: settings, defaults: baselineSettings, originalPlan: ORIGINAL_PLAN });
}

// Widen the right sidebar past the `.cc-controls` 360px container-query
// threshold so the Ask / Plan / Act labels render (README scenes only).
async function widen(page: Page, px: number): Promise<void> {
  await setRightSidebarWidth(page, px);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.describe("README captures", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    harness = await launchObsidianHarness({
      claudeCli: true,
      endpointModels: ["local-model"],
      endpointReply: "Your vault summary is ready — generated entirely on this device.",
      extraFiles: { "Build plan.md": ORIGINAL_PLAN },
      providerReply: (body) => {
        if (/copyeditor/i.test(body)) return ENRICHED_PLAN;
        if (body.includes("What should I work on next?")) return CHAT_REPLY;
        return null;
      },
      providerFail: (body) => body.includes("Summarize my vault in one line.") ? 503 : null,
      settingsOverride: {
        authMode: "oauthToken",
        oauthToken: "sk-ant-oat-e2e",
        chatBackend: "claude",
        model: "claude-sonnet-5",
        openaiCompatModel: "local-model",
        ollamaHost: "",
        agentModeEnabled: true,
        mcpEnabled: true,
        mcpPort: 22360,
        mcpToken: "3f9c1b7e2a6d4c8f9e0b1a2c3d4e5f60",
      },
      theme: "dark",
    });
    baselineSettings = await harness.page.evaluate(() => {
      const app = (window as unknown as {
        app: { plugins: { plugins: Record<string, { settings: Record<string, unknown> }> } };
      }).app;
      return structuredClone(app.plugins.plugins["claude-companion"].settings);
    });
  });
  test.afterAll(async () => {
    await harness?.close();
  });
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.skip(!ENABLED, "set CC_E2E_CAPTURE=1");
      test.skip(theme === "light" && !OUT_ROOT, "README assets are dark");

      test("chat-panel.png", async () => {
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5" });
        const root = await openChat(harness);
        await widen(harness.page, 520);
        const input = root.locator("textarea").first();
        await input.fill("What should I work on next?");
        await input.press("Enter");
        const answer = root.locator(".cc-msg.cc-assistant").last();
        await expect(answer).toContainText(CHAT_REPLY, { timeout: 15_000 });
        await shootThrough(root, answer, 331, "chat-panel.png", theme, PLUGIN_ASSETS);
      });

      test("composer-320.png", async () => {
        test.skip(!OUT_ROOT, "composer-320 is a comparison-only scene, not a README asset");
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5" });
        const root = await openChat(harness);
        await setRightSidebarWidth(harness.page, 320);
        // Let the `.cc-controls` container-query reflow settle after the resize.
        await harness.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const controls = root.locator(".cc-controls");
        // Capture regardless of the fit assertions below so a wrap is still evidenced.
        await shoot(root, "composer-320.png", theme);
        const metrics = await controls.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height }));
        console.log(`composer-320 (${theme}) metrics: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} height=${metrics.height}`);
        expect(metrics.scrollWidth, `control row must not overflow horizontally at 320px: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.clientWidth);
        expect(metrics.height, `control row must stay one line: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(40);
      });

      test("diff-review.png", async () => {
        // "Enrich with Claude…" (not the single-edit rewrite path): its lint step
        // sends the whole note to the utility (here: chat-role/Anthropic-stub)
        // model and diffToEdits() turns the returned full copy into edits, one per
        // LCS-changed region merged only when within MERGE_GAP (3) lines of each
        // other — a changed heading and a changed last task, six unchanged lines
        // apart, stay two separate edits and so two separate .cc-diff-hunk boxes.
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5" });
        const { page } = harness;
        await page.evaluate(async () => {
          const w = window as unknown as {
            app: {
              vault: { getAbstractFileByPath(path: string): unknown };
              plugins: { plugins: Record<string, { enrichNoteFlow(file: unknown, options: { rename: boolean; frontmatter: boolean; links: boolean; lint: boolean }): Promise<void> }> };
            };
          };
          const file = w.app.vault.getAbstractFileByPath("Build plan.md");
          // Fire and forget: enrichNoteFlow() only resolves once the review
          // modal it opens is closed, which this test never does.
          void w.app.plugins.plugins["claude-companion"]!.enrichNoteFlow(file, { rename: false, frontmatter: false, links: false, lint: true });
        });
        const modal = page.locator(".modal", { has: page.locator(".cc-diff-hunk") });
        await expect(modal.locator(".cc-diff-hunk")).toHaveCount(2, { timeout: 15_000 });
        await shoot(modal, "diff-review.png", theme);
      });

      test("research-desk.png", async () => {
        await resetScene(theme);
        await run(harness.page, "claude-companion:open-research-desk");
        await expect(harness.page.getByRole("heading", { name: "Continuity research" })).toBeVisible();
        const desk = harness.page.locator('.workspace-leaf-content[data-type="claude-research-desk"]');
        await setRightSidebarWidth(harness.page, 760);
        await expect.poll(async () => (await desk.boundingBox())?.width ?? 0).toBeCloseTo(760, 0);
        await shoot(desk, "research-desk.png", theme);
      });

      test("research-workbench-intelligence.png", async () => {
        await resetScene(theme);
        // Open the seeded project note first so the workbench infers it as the
        // active project (unlike the desk, it has no first-project fallback).
        await harness.page.evaluate(async () => {
          const app = (window as unknown as {
            app: {
              vault: { getAbstractFileByPath(path: string): unknown };
              workspace: { getLeaf(newLeaf: boolean): { openFile(file: unknown): Promise<void> } };
            };
          }).app;
          const project = app.vault.getAbstractFileByPath("Research/Alpha/Project.md");
          if (!project) throw new Error("Research fixture project is missing");
          await app.workspace.getLeaf(false).openFile(project);
        });
        await run(harness.page, "claude-companion:open-research-workbench");
        const leaf = harness.page.locator('.workspace-leaf-content[data-type="claude-research-workbench"]');
        const workbench = leaf.locator(".cc-research-workbench");
        await expect(workbench).toBeVisible();
        await expect(workbench.getByRole("heading", { name: "Continuity research" })).toBeVisible();
        // Widen past the 720px tabs/select container-query threshold so the
        // real tab buttons (not the compact <select>) are visible and clickable.
        await setRightSidebarWidth(harness.page, 760);
        await expect.poll(async () => (await leaf.boundingBox())?.width ?? 0).toBeCloseTo(760, 0);
        const intelligence = workbench.getByRole("tab", { name: "Intelligence" });
        await intelligence.click();
        await expect(workbench.getByRole("heading", { name: "Research intelligence" })).toBeVisible();
        await shoot(leaf, "research-workbench-intelligence.png", theme);
      });

      test("mcp-bridge-settings.png", async () => {
        await resetScene(theme, { mcpEnabled: true, mcpPort: 22360, mcpToken: "3f9c1b7e2a6d4c8f9e0b1a2c3d4e5f60" });
        const settingsPage = await harness.openSettings();
        const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
        const header = tab.getByText("Agent bridge — MCP server (desktop)", { exact: true });
        await header.click();
        await expect(tab.getByText(/✓ Running at /)).toBeVisible({ timeout: 15_000 });
        await shoot(tab, "mcp-bridge-settings.png", theme);
      });

      test("local-fallback-indicator.png", async () => {
        await resetScene(theme, { chatBackend: "auto", model: "claude-sonnet-5", openaiCompatModel: "local-model", ollamaHost: "" });
        const root = await openChat(harness);
        await widen(harness.page, 420);
        const input = root.locator("textarea").first();
        await input.fill("Summarize my vault in one line.");
        await input.press("Enter");
        await expect(root.locator(".cc-fallback-note")).toBeVisible({ timeout: 30_000 });
        const answer = root.locator(".cc-msg.cc-assistant").last();
        await expect(answer).toContainText("generated entirely on this device", { timeout: 15_000 });
        await expect(root.locator(".cc-error")).toHaveCount(0);
        await shootThrough(root, answer, 376, "local-fallback-indicator.png", theme);
      });

      test("agent-tool-chips.png", async () => {
        await resetScene(theme, { chatBackend: "claude-cli", agentModeEnabled: true, model: "claude-sonnet-5" });
        const root = await openChat(harness);
        await widen(harness.page, 520);
        const input = root.locator("textarea").first();
        await input.fill("Which evidence weakens my continuity claim?");
        await input.press("Enter");
        const chips = root.locator(".cc-tool-chip");
        await expect(chips).toHaveCount(2, { timeout: 30_000 });
        await chips.nth(1).locator("summary").click();
        // Crop to the transcript only: from top of .cc-chat-root down to bottom
        // of last assistant bubble, excluding the composer.
        // Hide the composer so nothing overflows and causes horizontal scroll offset.
        await harness.page.addStyleTag({ content: ".cc-chat-root .cc-composer, .cc-chat-root textarea { display: none !important; }" });
        // Reset every horizontal scroll: a wide row (e.g. the usage bar) can leave
        // an ancestor mid-horizontal-scroll; pin every scrollable element back to
        // its left edge before measuring bounding boxes.
        await harness.page.evaluate(() => {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
            if (el.scrollLeft) el.scrollLeft = 0;
          }
          window.scrollTo(0, 0);
        });
        const bubble = root.locator(".cc-msg.cc-assistant").last();
        await shootThrough(root, bubble, 476, "agent-tool-chips.png", theme);
      });
    });
  }
});
