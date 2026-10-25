import { expect, test } from "./fixtures";

test.use({ actionTimeout: 10_000 });

for (const scenario of [
  {
    name: "factual bullet summary",
    prompt: "Summarize my active note as three factual bullet points. Keep the limitations clear.",
    reply: "- The pilot involved four participants and had no control group.\n- Participants preferred a consolidated checklist.\n- Productivity and error reductions remain unproven.",
    folder: "Claude/Chats/",
    type: "chat",
    plan: false,
  },
  {
    name: "explicit build plan",
    prompt: "Make an implementation plan to organize the pilot notes.",
    reply: "## Build tasks\n- [ ] Create a pilot index note\n- [ ] Link the four participant notes",
    folder: "Claude/Plans/",
    type: "plan",
    plan: true,
  },
]) {
  test(`classifies and saves ${scenario.name}`, async ({ rig }, testInfo) => {
    const { page } = await rig.reset({
      extraFiles: { "Pilot reading.md": "# Checklist pilot\n\nFour participants tried a consolidated checklist. There was no control group. Participants preferred the checklist, but productivity and error reductions have not been established." },
      settingsOverride: { autoTagOnSave: false, agentModeEnabled: false },
      providerReply: [{ match: ".", replies: [scenario.reply] }],
    });
    await page.getByText("Pilot reading", { exact: true }).click();
    await page.locator('[aria-label="Open Companion for Claude"]').click();
    const chat = page.locator(".cc-chat-root");
    await chat.locator("textarea").fill(scenario.prompt);
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toContainText(scenario.plan ? "Create a pilot index note" : "The pilot involved four participants");
    // Wait for streaming to finish before checking the final action set.
    const save = chat.getByRole("button", { name: "Save as note", exact: true });
    await expect(save).toBeVisible();
    await expect(chat.getByRole("button", { name: "Implement", exact: true })).toHaveCount(scenario.plan ? 1 : 0);
    await expect(chat.getByRole("button", { name: "Build", exact: true })).toHaveCount(scenario.plan ? 1 : 0);
    await save.click();
    const savedNote = () => page.evaluate(async () => {
      const app = (window as unknown as { app: {
        workspace: { getActiveFile(): { path: string } | null };
        vault: { read(file: { path: string }): Promise<string> };
      } }).app;
      const file = app.workspace.getActiveFile();
      return { path: file?.path ?? "", content: file ? await app.vault.read(file) : "" };
    });
    await expect.poll(async () => (await savedNote()).path.startsWith(scenario.folder)).toBe(true);
    const saved = await savedNote();
    expect(saved.content).toContain(`type: "${scenario.type}"`);
    expect(saved.content).toContain(scenario.reply);
    await page.screenshot({ path: testInfo.outputPath("saved-reply.png") });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`reply actions, saved notes, and resumed context in ${theme} theme`, async ({ rig }) => {
    const { page } = await rig.reset({
      theme,
      extraFiles: { "UX Source.md": "# Weekly review\n\nReview the draft and send it to the team.\n" },
      settingsOverride: {
        autoTagOnSave: false,
        agentModeEnabled: false,
        context: { activeNote: true, selection: true, linkedNotes: false, searchVault: false },
      },
      providerReply: [{ match: ".", replies: ["The draft needs review before it is sent to the team."] }],
    });
    await page.evaluate(async () => {
      await (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app.commands.executeCommandById("claude-companion:open-chat");
    });
    await page.getByText("UX Source", { exact: true }).click();
    const chat = page.locator(".cc-chat-root");
    const context = chat.locator(".cc-context-trigger");
    await expect(context).toHaveText("Context · This note");
    await context.click();
    const manager = chat.getByRole("dialog", { name: "Message context" });
    await expect(manager.getByLabel("Selection", { exact: true })).toBeChecked();
    await expect(manager).toContainText("No text selected");
    await page.screenshot({ path: test.info().outputPath("empty-selection.png"), timeout: 5000 });
    await manager.getByRole("button", { name: "Close message context" }).click();
    await chat.locator("textarea").fill("Summarize my note.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    await expect(chat.locator(".cc-assistant .cc-body")).toContainText("The draft needs review");
    await expect(chat.locator(".cc-user .cc-context-note")).toContainText("UX Source.md");
    const save = chat.getByRole("button", { name: "Save as note", exact: true });
    await expect(save).toBeVisible();
    await expect(chat.locator(".cc-assistant")).toHaveCSS("opacity", "1");
    await page.mouse.move(500, 150);
    await chat.locator("textarea").focus();
    const contrast = await save.evaluate((button) => {
      const icon = button.querySelector("svg") ?? button;
      const style = getComputedStyle(icon);
      let background = "";
      let opacity = 1;
      for (let node: Element | null = icon; node; node = node.parentElement) {
        const current = getComputedStyle(node);
        opacity *= Number(current.opacity);
        const color = current.backgroundColor;
        if (/^rgb\(/.test(color)) { background = color; break; }
      }
      const channel = (value: number): number => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const rgb = (color: string): number[] => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const bg = rgb(background);
      const fg = rgb(style.stroke === "none" ? style.color : style.stroke).map((c, i) => c * opacity + bg[i]! * (1 - opacity));
      const luminance = (color: number[]): number => color.map(channel).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
      const a = luminance(fg), b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: test.info().outputPath("reply-actions.png"), timeout: 5000 });
    await save.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { app: { workspace: { getActiveFile(): { path: string } | null } } }).app.workspace.getActiveFile()?.path)).toMatch(/^Claude\/Chats\//);
    await page.screenshot({ path: test.info().outputPath("saved-note-open.png"), timeout: 5000 });
    await rig.reloadPlugin();
    await expect(page.locator(".cc-chat-root .cc-user .cc-context-note")).toContainText("active note: UX Source.md");
    await page.screenshot({ path: test.info().outputPath("resumed-context.png"), timeout: 5000 });
  });
}
