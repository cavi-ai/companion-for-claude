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

    const started = Date.now();
    await plan.click();
    const notice = page.locator(".notice").filter({ hasText: "Plan Mode: on" });
    await expect(notice).toBeVisible({ timeout: 500 });
    expect(Date.now() - started).toBeLessThan(500);
    // The clear budget runs from when the notice appeared, not from before the
    // click: one shared window makes a 1.8s notice fail whenever the click and
    // the first poll are slow, which is a harness stall, not a regression.
    const shown = Date.now();
    await expect(notice).toBeHidden({ timeout: 2_500 });
    expect(Date.now() - shown).toBeLessThan(2_500);
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
    await expect(activity).toHaveAttribute("aria-label", /Finding themes.*in progress/);
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
