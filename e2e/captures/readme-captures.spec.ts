import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { Rig } from "../fixtures";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setRightSidebarWidth } from "../rig/pageOps.ts";

const ENABLED = process.env.CC_E2E_CAPTURE === "1";
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets");
const PLUGIN_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const THEMES = (process.env.CC_E2E_CAPTURE_THEME ?? "both") === "both" ? (["dark", "light"] as const) : [process.env.CC_E2E_CAPTURE_THEME as "dark" | "light"];
const OUT_ROOT = process.env.CC_E2E_CAPTURE_DIR;
const CAPTURE_SCALE = 2;
const CHAT_REPLY = [
  "Review the proposed passage on page 8 first. It is the only evidence that challenges [[Continuity claim]], and the claim still needs a limitation that answers it.",
  "Then extend the white paper: its first section is drafted, and the next one can reuse the two reviewed passages that already support the claim.",
  "Finish by running the audit so the draft and its sources stay in sync.",
].join("\n\n");
const CHAT_REPLY_LEAD = "Review the proposed passage on page 8 first.";
const DRAFT_SENTENCE = "Provenance keeps each passage traceable to its source, so continuity survives edits [@source-continuity-study].";
const DRAFT_REPLY = JSON.stringify({
  markdown: DRAFT_SENTENCE,
  support: [{
    passage: DRAFT_SENTENCE,
    claimPath: "Research/Alpha/Claims/Continuity claim.md",
    evidencePaths: ["Research/Alpha/Evidence/Stale result.md", "Research/Alpha/Evidence/Replication result.md"],
    citationKeys: ["source-continuity-study"],
  }],
  gaps: [],
});
const ORIGINAL_PLAN = "# Build plan\n\nNotes for implementation.\n\n- [ ] Create the parser\n- [ ] Wire the interface\n- [ ] Write tests\n- [ ] Ship it\n";
const ENRICHED_PLAN = "# Build Plan\n\nNotes for implementation.\n\n- [ ] Create the parser\n- [ ] Wire the interface\n- [ ] Write tests\n- [ ] Ship it to users\n";
function note(frontmatter: string, body: string): string { return `---\n${frontmatter}\n---\n\n${body}\n`; }

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const ALPHA = "Research/Alpha";
const ALPHA_EVIDENCE = [`${ALPHA}/Evidence/Stale result.md`, `${ALPHA}/Evidence/Replication result.md`];
const DRAFT_ENVELOPE = {
  id: "continuity-claim",
  claimPaths: [`${ALPHA}/Claims/Continuity claim.md`],
  evidence: ALPHA_EVIDENCE.map((path) => ({ path, fingerprint: "sha256:new" })),
  citations: [{ key: "source-continuity-study", sourcePath: `${ALPHA}/Sources/Study.md` }],
  provider: "companion",
  model: "evidence-outline-v1",
  generatedAt: "outline",
};
const DRAFT_SEED = "Provenance preserves continuity.";
const DRAFT_SECTION = `<!-- cavi:draft-section version=1 meta=${encodeURIComponent(JSON.stringify(DRAFT_ENVELOPE))} fingerprint=fnv1a-${fnv1aHex(DRAFT_SEED)} -->\n${DRAFT_SEED}\n<!-- cavi:draft-section:end id=${DRAFT_ENVELOPE.id} -->`;

const WEEKLY_REVIEW = "## Progress\n\n- Finished the source import for the continuity study.\n- Reviewed two passages against their sources.\n\n## Next\n\n- Draft the white paper introduction.\n- Resolve the open question about mechanism.\n";
const WEEKLY_EDITS = [
  { old_str: "- Finished the source import for the continuity study.", new_str: "- Imported the continuity study and checked its fingerprint." },
  { old_str: "- Draft the white paper introduction.", new_str: "- Draft the white paper introduction by Friday." },
];
const WEEKLY_ASK = "Make my next steps specific.";
const WEEKLY_REPLY = "Two edits are ready for your review in the note.";

const TAGGED_NOTES: Record<string, string[]> = {
  "Notes/Kickoff meeting.md": ["meeting-notes", "workflow", "research"],
  "Notes/Review meeting.md": ["meeting-notes", "evidence-review", "provenance"],
  "Notes/Planning meeting.md": ["meeting-notes", "workflow", "planning"],
  "Notes/Retro meeting.md": ["meeting-notes", "evidence-review", "draft"],
  "Notes/Sync meeting.md": ["meeting_notes", "workflows", "review-evidence"],
  "Notes/Source audit.md": ["provenance", "evidence-review", "workflow", "research"],
  "Notes/Citation check.md": ["provenance", "provenence", "research", "planning"],
  "Notes/Draft outline.md": ["draft", "research"],
};

const TASK_SCHEMA = [
  "---", "ontology: type", "type_name: task", "version: 1", "---", "",
  "```yaml", "properties:", "  - key: status", "    type: \"string\"", "    required: true", "```", "",
  "Edit the yaml block above to change the `task` schema.", "",
].join("\n");

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Continuity research status</title><style>
:root{--ivory:#FAF9F5;--slate:#141413;--clay:#D97757;--olive:#788C5D;--gray-150:#F0EEE6;--gray-300:#D1CFC5;--gray-500:#87867F;--gray-700:#3D3D3A;--serif:ui-serif,Georgia,serif;--sans:system-ui,-apple-system,sans-serif;--mono:Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--ivory);color:var(--gray-700);font:14px/1.5 var(--sans)}
.page{padding:24px 28px}.eyebrow{font:600 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--gray-500)}
h1{font:500 26px var(--serif);letter-spacing:-.01em;color:var(--slate);margin:4px 0 16px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.tile{background:#fff;border:1.5px solid var(--gray-300);border-radius:12px;padding:12px 14px}
.num{font:500 28px var(--serif);color:var(--slate)}.num.key{color:var(--clay)}.lbl{font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--gray-500)}
.cols{display:grid;grid-template-columns:1.1fr 1fr;gap:14px;margin-top:14px}.card{background:var(--gray-150);border:1.5px solid var(--gray-300);border-radius:12px;padding:14px 16px}
h2{font:500 15px var(--serif);color:var(--slate);margin:0 0 10px}.bar{display:grid;grid-template-columns:84px 1fr 24px;gap:8px;align-items:center;margin:7px 0;font-size:12px}
.track{height:9px;background:#fff;border-radius:999px;overflow:hidden}.fill{display:block;height:100%;border-radius:999px;background:var(--olive)}.fill.clay{background:var(--clay)}.val{font:600 11px var(--mono);color:var(--gray-500);text-align:right}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:8px;align-items:center;margin:6px 0;font-size:12.5px}.dot{width:9px;height:9px;border-radius:50%;border:1.5px solid var(--gray-300);background:#fff}.dot.done{background:var(--olive);border-color:var(--olive)}.dot.now{background:var(--clay);border-color:var(--clay)}
</style></head><body><div class="page"><div class="eyebrow">Project status</div><h1>Continuity research</h1>
<div class="tiles"><div class="tile"><div class="num">1</div><div class="lbl">Source</div></div><div class="tile"><div class="num">3</div><div class="lbl">Passages</div></div><div class="tile"><div class="num">1</div><div class="lbl">Claim</div></div><div class="tile"><div class="num key">1 of 1</div><div class="lbl">Sections drafted</div></div></div>
<div class="cols"><div class="card"><h2>Passages by review state</h2>
<div class="bar"><span>Supporting</span><span class="track"><span class="fill" style="width:67%"></span></span><span class="val">2</span></div>
<div class="bar"><span>Reviewed</span><span class="track"><span class="fill" style="width:67%"></span></span><span class="val">2</span></div>
<div class="bar"><span>Proposed</span><span class="track"><span class="fill clay" style="width:33%"></span></span><span class="val">1</span></div>
<div class="bar"><span>Challenging</span><span class="track"><span class="fill clay" style="width:33%"></span></span><span class="val">1</span></div></div>
<div class="card"><h2>Where the project stands</h2><ul>
<li><span class="dot done"></span>Frame the question</li><li><span class="dot done"></span>Capture sources</li><li><span class="dot done"></span>Review passages</li><li><span class="dot now"></span>Draft the white paper</li><li><span class="dot"></span>Audit the argument</li></ul></div></div></div></body></html>`;
const PROJECT_STATUS = `A snapshot of the Continuity research project.\n\n\`\`\`claude-html height=370\n${DASHBOARD_HTML}\n\`\`\`\n`;

const SCENE_FILES: Record<string, string> = {
  "Build plan.md": ORIGINAL_PLAN,
  "Weekly review.md": WEEKLY_REVIEW,
  "Notes/Project status.md": PROJECT_STATUS,
  "Notes/Meeting 2026-03-04.md": "# Meeting 2026-03-04\n\nFollow-ups: [[Budget outline]] and [[Vendor list]].\n",
  "Notes/Linked.md": "# Linked\n\nSee [[Missing note]].\n",
  "Ontology/task.md": TASK_SCHEMA,
  "Notes/Task one.md": "---\ntype: task\n---\n# Task one\n",
  ...Object.fromEntries(Object.entries(TAGGED_NOTES).map(([path, tags]) => [path, `---\ntags: [${tags.join(", ")}]\n---\n\n# ${path.slice(6, -3)}\n\nStandalone working note.\n`])),
  [`${ALPHA}/Evidence/Stale result.md`]: note('title: "Provenance links hold"\ntype: "evidence"\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nsource_fingerprint: "sha256:new"\nlocator_kind: page\nlocator_value: "4"\nreview_state: reviewed', "> Continuity improves with provenance."),
  [`${ALPHA}/Evidence/Replication result.md`]: note('title: "Replication result"\ntype: "evidence"\nproject: "[[Research/Alpha/Project.md]]"\nsource: "[[Research/Alpha/Sources/Study.md]]"\nsource_fingerprint: "sha256:new"\nlocator_kind: page\nlocator_value: "12"\nreview_state: reviewed', "> The replication kept continuity when source links stayed intact."),
  [`${ALPHA}/Claims/Continuity claim.md`]: note('title: "Continuity claim"\ntype: "claim"\nproject: "[[Research/Alpha/Project.md]]"\nproposition: "Provenance preserves continuity."\nconfidence: moderate\nreview_state: reviewed\nsupports:\n  - "[[Research/Alpha/Evidence/Stale result.md]]"\n  - "[[Research/Alpha/Evidence/Replication result.md]]"\nchallenges:\n  - "[[Research/Alpha/Evidence/Challenge.md]]"\ncontextualizes: []\nlimitations:\n  - "One workflow was studied"', "# Claim"),
  [`${ALPHA}/Documents/Draft.md`]: note('title: "White paper"\ntype: "research-document"\nproject: "[[Research/Alpha/Project.md]]"\ndocument_kind: draft\nclaims:\n  - "[[Research/Alpha/Claims/Continuity claim.md]]"', `# White paper\n\n${DRAFT_SECTION}`),
};

let harness: Rig;
let baselineSettings: Record<string, unknown>;

function outputPath(name: string, theme: "dark" | "light", assetRoot = ASSETS): string {
  return OUT_ROOT ? join(OUT_ROOT, theme, name) : join(assetRoot, name);
}

async function prepareCapture(target: Locator | Page): Promise<Page> {
  const targetPage = "page" in target && typeof (target as Locator).page === "function" ? (target as Locator).page() : (target as Page);
  await targetPage.evaluate(() => {
    document.querySelectorAll(".notice, .cc-turn-complete-status").forEach((n) => n.remove());
    // A wide row (e.g. the usage bar) can leave an ancestor mid-horizontal-scroll;
    // pin every scrollable element back to its left edge before cropping.
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (el.scrollWidth > el.clientWidth) el.scrollTo({ left: 0, behavior: "instant" });
    });
    return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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
  const page = await prepareCapture(target);
  const box = "boundingBox" in target ? await target.boundingBox() : (() => { const size = page.viewportSize(); return size ? { x: 0, y: 0, ...size } : null; })();
  if (!box) throw new Error(`Failed to measure ${name}`);
  await captureClip(page, box, name, theme, assetRoot);
}

async function captureClip(page: Page, clip: { x: number; y: number; width: number; height: number }, name: string, theme: "dark" | "light", assetRoot: string): Promise<void> {
  const path = outputPath(name, theme, assetRoot);
  await mkdir(dirname(path), { recursive: true });
  // Playwright screenshots a CDP-attached Electron page at 1x; capture through CDP and correct to a fixed 2x.
  const cdp = await page.context().newCDPSession(page);
  try {
    const shot = async (scale: number): Promise<Buffer> => Buffer.from((await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale },
    })).data, "base64");
    let png = await shot(1);
    const native = png.readUInt32BE(16) / clip.width;
    if (Math.abs(native - CAPTURE_SCALE) > 0.01) png = await shot(CAPTURE_SCALE / native);
    await writeFile(path, png);
  } finally {
    await cdp.detach();
  }
  await verifyCapture(path, name);
}

async function shootThrough(root: Locator, end: Locator, cssHeight: number, name: string, theme: "dark" | "light", assetRoot = ASSETS): Promise<void> {
  const page = await prepareCapture(root);
  const rootBox = await root.boundingBox();
  const endBox = await end.boundingBox();
  if (!rootBox || !endBox) throw new Error(`Failed to measure ${name}`);
  expect(endBox.y + endBox.height - rootBox.y + 12, `${name} content must fit its fixed crop`).toBeLessThanOrEqual(cssHeight);
  await captureClip(page, { x: rootBox.x, y: rootBox.y, width: rootBox.width, height: cssHeight }, name, theme, assetRoot);
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Failed to measure ${selector}`);
  return box;
}

// A fixed-size window crop: "dock" ends at the right edge of the right sidebar, "center" is centered on the editor area.
async function shootWindow(page: Page, anchor: "dock" | "center", width: number, height: number, name: string, theme: "dark" | "light", assetRoot = ASSETS): Promise<void> {
  await prepareCapture(page);
  const root = await boxOf(page, ".workspace-split.mod-root");
  const rightSplit = anchor === "dock" ? await boxOf(page, ".workspace-split.mod-right-split") : root;
  const x = anchor === "dock" ? rightSplit.x + rightSplit.width - width : root.x + (root.width - width) / 2;
  expect(x, `${name} window crop must start inside the app window`).toBeGreaterThanOrEqual(0);
  await captureClip(page, { x, y: root.y, width, height }, name, theme, assetRoot);
}

async function run(page: Page, id: string): Promise<void> {
  await page.evaluate(async (commandId) => {
    await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById(commandId);
  }, id);
}

async function openChat(harness: Rig): Promise<Locator> {
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
  await harness.page.evaluate(async ({ nextTheme, nextSettings, defaults, restore }) => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(nextTheme === "dark" ? "theme-dark" : "theme-light");
    const app = (window as unknown as {
      app: {
        plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings(): Promise<void>; startNewConversation(): Promise<void> }> };
        workspace: { getLeavesOfType(type: string): Array<{ detach(): void }>; leftSplit: { expand(): void }; rightSplit: { expand(): void; containerEl: HTMLElement } };
        vault: { getAbstractFileByPath(path: string): unknown; modify(file: unknown, data: string): Promise<void> };
      };
    }).app;
    const plugin = app.plugins.plugins["claude-companion"];
    Object.assign(plugin.settings, defaults, nextSettings);
    await plugin.saveSettings();
    await plugin.startNewConversation();
    for (const type of ["claude-companion-chat", "claude-research-desk", "claude-system", "markdown"]) {
      for (const leaf of app.workspace.getLeavesOfType(type)) leaf.detach();
    }
    for (const [path, content] of Object.entries(restore)) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.vault.modify(file, content);
    }
    app.workspace.leftSplit.expand();
    app.workspace.rightSplit.expand();
    for (const property of ["display", "position", "inset", "width", "min-width", "max-width", "flex", "flex-basis", "z-index"]) {
      app.workspace.rightSplit.containerEl.style.removeProperty(property);
    }
  }, { nextTheme: theme, nextSettings: settings, defaults: baselineSettings, restore: { "Build plan.md": ORIGINAL_PLAN, "Weekly review.md": WEEKLY_REVIEW } });
}

async function collapseSidebars(page: Page, sides: Array<"left" | "right">): Promise<void> {
  await page.evaluate((which) => {
    const workspace = (window as unknown as { app: { workspace: { leftSplit: { collapse(): void }; rightSplit: { collapse(): void } } } }).app.workspace;
    if (which.includes("left")) workspace.leftSplit.collapse();
    if (which.includes("right")) workspace.rightSplit.collapse();
  }, sides);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function openNote(page: Page, link: string, mode: "source" | "preview" = "source"): Promise<void> {
  await page.evaluate(async ({ target, viewMode }) => {
    const app = (window as unknown as {
      app: {
        metadataCache: { getFirstLinkpathDest(link: string, source: string): unknown };
        workspace: { getLeaf(kind: string): { openFile(file: unknown, state?: unknown): Promise<void> } };
      };
    }).app;
    const file = app.metadataCache.getFirstLinkpathDest(target, "");
    if (!file) throw new Error(`Note not found: ${target}`);
    await app.workspace.getLeaf("tab").openFile(file, { state: { mode: viewMode } });
  }, { target: link, viewMode: mode });
}

interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  toolTrace?: Array<{ name: string; argsSummary: string; resultPreview: string; ok: boolean }>;
}

async function seedConversation(page: Page, messages: SeedMessage[], proposal?: { path: string; description: string; edits: Array<{ old_str: string; new_str: string }> }): Promise<void> {
  await page.evaluate(async ({ seed, edit }) => {
    const app = (window as unknown as { app: { plugins: { plugins: Record<string, {
      beginActiveConversationTurn(id: string | null, messages: unknown[], input: { backend: string; model: string; mode: string }): Promise<{ conversationId: string; turnId: string }>;
      completeActiveConversationTurn(id: string, turnId: string, messages: unknown[]): Promise<void>;
      saveChatEditProposal(id: string, proposal: unknown): Promise<void>;
    }> } } }).app;
    const plugin = app.plugins.plugins["claude-companion"]!;
    const turn = await plugin.beginActiveConversationTurn(null, seed.slice(0, 1), { backend: "anthropic", model: "claude-sonnet-5-5", mode: "act" });
    await plugin.completeActiveConversationTurn(turn.conversationId, turn.turnId, seed);
    if (edit) await plugin.saveChatEditProposal(turn.conversationId, edit);
  }, { seed: messages, edit: proposal ?? null });
}

// Widen the right sidebar past the `.cc-controls` 360px container-query
// threshold so the Ask / Plan / Act labels render (README scenes only).
async function widen(page: Page, px: number): Promise<void> {
  await setRightSidebarWidth(page, px);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.describe("README captures", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async ({ rig }) => {
    harness = await rig.reset({
      claudeCli: true,
      endpointModels: ["local-model"],
      endpointReply: "Your vault summary is ready — generated entirely on this device.",
      extraFiles: SCENE_FILES,
      providerReply: [
        { match: "copyeditor", flags: "i", replies: [ENRICHED_PLAN] },
        { match: "Draft one research-document section", replies: [DRAFT_REPLY] },
        { match: "What should I work on next?", replies: [CHAT_REPLY] },
      ],
      providerFail: [{ match: "Summarize my vault in one line.", status: 503 }],
      settingsOverride: {
        authMode: "oauthToken",
        oauthToken: "sk-ant-oat-e2e",
        chatBackend: "claude",
        model: "claude-sonnet-5-5",
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
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5-5" });
        const root = await openChat(harness);
        await widen(harness.page, 520);
        const input = root.locator("textarea").first();
        await input.fill("What should I work on next?");
        await input.press("Enter");
        const answer = root.locator(".cc-msg.cc-assistant").last();
        await expect(answer).toContainText(CHAT_REPLY_LEAD, { timeout: 15_000 });
        await expect(answer.locator("a.internal-link")).toHaveCount(1);
        await shootThrough(root, answer, 386, "chat-panel.png", theme, PLUGIN_ASSETS);
      });

      test("composer-320.png", async () => {
        test.skip(!OUT_ROOT, "composer-320 is a comparison-only scene, not a README asset");
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5-5" });
        const root = await openChat(harness);
        await setRightSidebarWidth(harness.page, 320);
        // Let the `.cc-controls` container-query reflow settle after the resize.
        await harness.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const controls = root.locator(".cc-controls");
        // Capture regardless of the fit assertions below so a wrap is still evidenced.
        const rootBox = await root.boundingBox();
        if (!rootBox) throw new Error("Failed to measure composer-320");
        // Full-height 320px pane exceeds the 1600px output cap at 2x; the composer sits at the bottom.
        const cropHeight = Math.min(rootBox.height, 640);
        await captureClip(harness.page, { x: rootBox.x, y: rootBox.y + rootBox.height - cropHeight, width: rootBox.width, height: cropHeight }, "composer-320.png", theme, ASSETS);
        const metrics = await controls.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height }));
        console.log(`composer-320 (${theme}) metrics: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} height=${metrics.height}`);
        expect(metrics.scrollWidth, `control row must not overflow horizontally at 320px: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.clientWidth);
        expect(metrics.height, `control row must stay one line: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(40);
      });

      test("diff-review.png", async () => {
        // "Tidy with Claude…" (not the single-edit rewrite path): its lint step
        // sends the whole note to the utility (here: chat-role/Anthropic-stub)
        // model and diffToEdits() turns the returned full copy into edits, one per
        // LCS-changed region merged only when within MERGE_GAP (3) lines of each
        // other — a changed heading and a changed last task, six unchanged lines
        // apart, stay two separate edits and so two separate .cc-diff-hunk boxes.
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5-5" });
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
        const progress = desk.locator(".cc-desk-document-progress");
        await expect(progress).toBeVisible();
        if (/^0 of/.test(await progress.innerText())) {
          await desk.locator(".cc-desk-step", { hasText: 'Draft "Continuity claim"' }).click();
          await desk.getByRole("button", { name: "Accept section", exact: true }).click();
        }
        await expect(progress).toContainText("1 of 1 section drafted");
        const hide = desk.getByRole("button", { name: "Hide sections", exact: true });
        if (await hide.count()) await hide.click();
        await expect(desk).not.toContainText("No tracked sections");
        await expect(desk).not.toContainText("Unsupported");
        await shootThrough(desk, desk.locator(".cc-desk-sources"), 658, "research-desk.png", theme);
      });

      test("mcp-bridge-settings.png", async () => {
        await resetScene(theme, { mcpEnabled: true, mcpPort: 22360, mcpToken: "3f9c1b7e2a6d4c8f9e0b1a2c3d4e5f60" });
        const settingsPage = await harness.openSettings();
        await settingsPage.setViewportSize({ width: 1000, height: 760 });
        const tab = settingsPage.locator(".vertical-tab-content-container .vertical-tab-content").last();
        const header = tab.getByText("Agent bridge — MCP server (desktop)", { exact: true });
        await header.click();
        await expect(tab.getByText(/✓ Running at /)).toBeVisible({ timeout: 15_000 });
        await settingsPage.addStyleTag({ content: "*::-webkit-scrollbar { display: none; }" });
        await prepareCapture(settingsPage);
        const tabBox = await tab.boundingBox();
        if (!tabBox) throw new Error("Failed to measure mcp-bridge-settings");
        // Skip the back chevron at the tab's left edge; end on a divider between settings rows.
        expect(tabBox.height, "settings tab must be tall enough for the fixed crop").toBeGreaterThanOrEqual(712);
        expect(tabBox.width, "settings tab must be wide enough for the fixed crop").toBeGreaterThanOrEqual(692);
        await captureClip(settingsPage, { x: tabBox.x + 12, y: tabBox.y, width: 680, height: 712 }, "mcp-bridge-settings.png", theme, ASSETS);
      });

      test("local-fallback-indicator.png", async () => {
        await resetScene(theme, { chatBackend: "auto", model: "claude-sonnet-5-5", openaiCompatModel: "local-model", ollamaHost: "" });
        const root = await openChat(harness);
        await widen(harness.page, 420);
        const input = root.locator("textarea").first();
        await input.fill("Summarize my vault in one line.");
        await input.press("Enter");
        await expect(root.locator(".cc-agent-notice", { hasText: "answered locally with local-model" })).toBeVisible({ timeout: 30_000 });
        const answer = root.locator(".cc-msg.cc-assistant").last();
        await expect(answer).toContainText("generated entirely on this device", { timeout: 15_000 });
        await expect(root.locator(".cc-error")).toHaveCount(0);
        await shootThrough(root, answer, 296, "local-fallback-indicator.png", theme);
      });

      test("agent-tool-chips.png", async () => {
        await resetScene(theme, { chatBackend: "claude-cli", agentModeEnabled: true, model: "claude-sonnet-5-5" });
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
        await shootThrough(root, bubble, 446, "agent-tool-chips.png", theme);
      });

      test("hero.png", async () => {
        await resetScene(theme, { chatBackend: "claude", model: "claude-sonnet-5-5" });
        const { page } = harness;
        await collapseSidebars(page, ["left"]);
        await seedConversation(page, [
          { role: "user", content: WEEKLY_ASK },
          {
            role: "assistant",
            content: WEEKLY_REPLY,
            toolTrace: [
              { name: "note_read", argsSummary: "Weekly review.md", resultPreview: "# Weekly review", ok: true },
              { name: "propose_note_edit", argsSummary: "Weekly review.md · 2 edits", resultPreview: "2 edits proposed", ok: true },
            ],
          },
        ], { path: "Weekly review.md", description: "Make the import line and first next step specific", edits: WEEKLY_EDITS });
        await openNote(page, "Weekly review");
        const root = await openChat(harness);
        // The hero is the whole 800x480 window, so the editor pane is exactly as narrow as the crop.
        await page.setViewportSize({ width: 800, height: 480 });
        try {
          await widen(page, 400);
          await expect(root.locator(".cc-tool-chip")).toHaveCount(2);
          await root.getByRole("button", { name: "Review proposed edit", exact: true }).click();
          await expect(page.locator(".cc-inline-add").first()).toBeVisible({ timeout: 15_000 });
          await prepareCapture(page);
          await captureClip(page, { x: 0, y: 0, width: 800, height: 480 }, "hero.png", theme, PLUGIN_ASSETS);
        } finally {
          await page.setViewportSize({ width: 1600, height: 1000 });
        }
      });

      test("artifact-inline.png", async () => {
        await resetScene(theme);
        const { page } = harness;
        await collapseSidebars(page, ["left", "right"]);
        await openNote(page, "Project status", "preview");
        await expect(page.frameLocator("iframe.cc-artifact-frame").first().locator("h1")).toHaveText("Continuity research", { timeout: 20_000 });
        await shootWindow(page, "center", 800, 600, "artifact-inline.png", theme, PLUGIN_ASSETS);
      });
    });
  }
});
