import { expect, test } from "./fixtures";

test("ephemeral Companion feedback appears immediately and clears within 2.5 seconds", async ({ rig }) => {
  const harness = await rig.reset();
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const plan = page.getByRole("radio", { name: "Plan — read-only exploration, proposes a plan" });
    await expect(plan).toBeVisible();
    // The notice's lifetime is timed inside the page, so Playwright's polling latency is not part of it.
    await page.evaluate(() => {
      const life: { shown?: number; hidden?: number } = {};
      (window as unknown as { __planNotice: typeof life }).__planNotice = life;
      const visible = (): boolean =>
        [...document.querySelectorAll<HTMLElement>(".notice")].some((el) => el.textContent?.includes("Plan Mode: on") && el.checkVisibility());
      new MutationObserver(() => {
        const now = performance.now();
        if (life.shown === undefined && visible()) life.shown = now;
        else if (life.shown !== undefined && life.hidden === undefined && !visible()) life.hidden = now;
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    });

    const started = Date.now();
    await plan.click();
    const notice = page.locator(".notice").filter({ hasText: "Plan Mode: on" });
    await expect(notice).toBeVisible({ timeout: 500 });
    await expect(page.locator(".cc-feedback-host .notice").filter({ hasText: "Plan Mode: on" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Dismiss feedback" })).toBeVisible();
    expect(Date.now() - started).toBeLessThan(500);
    await expect(notice).toBeHidden({ timeout: 5_000 });
    const life = await page.evaluate(() => (window as unknown as { __planNotice: { shown?: number; hidden?: number } }).__planNotice);
    expect(life.shown).toBeDefined();
    expect(life.hidden).toBeDefined();
    expect(life.hidden! - life.shown!).toBeLessThan(2_500);
  } finally {
    await harness.close();
  }
});

test("long-running themes stay in activity while completion feedback expires", async ({ rig }) => {
  const harness = await rig.reset({
    providerDelayMs: 7_000,
    extraFiles: { "Clippings/progress.md": "---\nsource_enriched: true\ntitle: Progress sample\n---\nA source about knowledge work." },
    providerReply: [{ match: "", replies: [JSON.stringify({ groups: [{ theme: "Knowledge", summary: "Knowledge work", researchIdea: "", paths: ["Clippings/progress.md"] }] })] }],
  });
  const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> }; plugins: { plugins: Record<string, { triageClippings(folder: string): Promise<void> }> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
      void app.plugins.plugins["claude-companion"]!.triageClippings("Clippings");
    });
    const activity = page.locator(".cc-chat-root .cc-activity-indicator");
    await expect(activity).toHaveAttribute("aria-label", /Activity: 1 task, In progress/);
    await expect(page.locator(".notice").filter({ hasText: "Finding themes" })).toHaveCount(0);
    await activity.click();
    const record = page.locator(".cc-chat-root .cc-activity-record").filter({ hasText: "Finding themes" });
    await record.locator("summary").first().click();
    await expect(record.locator(".cc-activity-current")).toHaveText("Grouping research themes");
    await page.screenshot({ path: test.info().outputPath("task-progress.png") });
    const completion = page.locator(".notice").filter({ hasText: "Themes:" });
    await expect(completion).toBeVisible({ timeout: 12_000 });
    await expect(completion).toBeHidden({ timeout: 6_000 });
    await expect(page.locator(".cc-activity-record.is-running").filter({ hasText: "Finding themes" })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});


test("keyboard dismissal and native expiry return focus to the composer", async ({ rig }) => {
  const harness = await rig.reset(); const { page } = harness;
  try {
    await page.evaluate(async () => {
      const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
      await app.commands.executeCommandById("claude-companion:open-chat");
    });
    const chat = page.locator(".cc-chat-root:visible").first();
    const input = chat.locator("textarea.cc-input");
    await input.fill("Continue this draft");
    for (const mode of ["dismiss", "expiry", "outside"] as const) {
      await input.focus();
      await page.evaluate(({ text, duration }) => {
        const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { semantic(): { deps: { notice(message: string, duration: number): { hide(): void } } } }> } } }).app.plugins.plugins["claude-companion"]!;
        (window as unknown as { __focusNotice: { hide(): void } }).__focusNotice = plugin.semantic().deps.notice(text, duration);
      }, { text: `Focus continuity ${mode}`, duration: mode === "expiry" ? 750 : 0 });
      const notice = chat.locator(".cc-feedback-host .notice").filter({ hasText: `Focus continuity ${mode}` });
      await expect(notice).toBeVisible(); await expect(input).toBeFocused();
      const dismiss = notice.getByRole("button", { name: "Dismiss feedback" }); await dismiss.focus();
      await expect(dismiss).toBeFocused();
      if (mode === "dismiss") await page.keyboard.press("Enter");
      if (mode === "outside") {
        const other = chat.getByRole("button", { name: "More actions" }); await other.focus();
        await page.evaluate(() => (window as unknown as { __focusNotice: { hide(): void } }).__focusNotice.hide());
        await expect(notice).toBeHidden(); await expect(other).toBeFocused();
      } else {
        await expect(notice).toBeHidden({ timeout: 3_000 }); await expect(input).toBeFocused();
      }
      await expect(input).toHaveValue("Continue this draft");
    }
  } finally { await harness.close(); }
});
