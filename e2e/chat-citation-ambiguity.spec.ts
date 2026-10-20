import { expect, test } from "./fixtures";

type AppWindow = { app: {
  commands: { executeCommandById(id: string): Promise<void> };
  metadataCache: { getFirstLinkpathDest(path: string, source: string): { path: string } | null };
  vault: { getAbstractFileByPath(path: string): unknown };
  workspace: { getActiveFile(): { path: string } | null; getLeaf(value: boolean): { openFile(file: unknown): Promise<void> } };
} };

for (const qualified of [false, true]) {
  test(`${qualified ? "qualified" : "ambiguous"} citations distinguish project notes with the same name`, async ({ rig }, testInfo) => {
    const a = "Projects/Client A/Overview.md", b = "Projects/Client B/Overview.md";
    const { page } = await rig.reset({
      settingsOverride: { agentModeEnabled: false, autoTagOnSave: false, context: { activeNote: true, selection: false, linkedNotes: false, searchVault: false } },
      extraFiles: { [a]: "# Client A\n\n## Findings\n\nClient A started in January.", [b]: "# Client B\n\n## Findings\n\nClient B started in September." },
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.metadataCache.getFirstLinkpathDest("Overview", "")?.path)).toBeTruthy();
    const global = await page.evaluate(() => (window as unknown as AppWindow).app.metadataCache.getFirstLinkpathDest("Overview", "")?.path);
    const selected = global === a ? b : a;
    const fact = selected === b ? "Client B started in September." : "Client A started in January.";
    const citation = qualified ? selected : "Overview";
    await rig.control.setStubs({ providerReply: [
      { match: qualified ? "full vault-relative path shown in the source" : ".", replies: [`${fact} [[${citation}#Findings]]`] },
      { match: ".", replies: ["No source-path instruction was sent."] },
    ] });
    await page.evaluate(async path => {
      const app = (window as unknown as AppWindow).app;
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(path));
      await app.commands.executeCommandById("claude-companion:open-chat");
    }, selected);
    const chat = page.locator(".cc-chat-root");
    await chat.locator(".cc-input").fill("When did this project start? Cite my active note.");
    await chat.getByRole("button", { name: /^Send(?: message)?$/ }).click();
    const reply = chat.locator(".cc-assistant").last();
    const footer = reply.locator(".cc-provenance");
    if (qualified) {
      await expect(footer).toContainText(fact);
      await expect(footer.locator(".cc-provenance-link")).toContainText(selected.replace(/\.md$/, ""));
      await footer.locator(".cc-provenance-link").click();
    } else {
      await expect(footer).toContainText("Multiple notes match");
      await expect(footer.locator(".cc-provenance-link")).toHaveCount(0);
      await expect(footer.locator(".cc-provenance-excerpt")).toHaveCount(0);
      await reply.locator(".cc-body .internal-link").click();
      await expect(page.locator(".notice")).toContainText("Several notes share this name");
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as AppWindow).app.workspace.getActiveFile()?.path)).toBe(selected);
    await rig.reloadPlugin();
    await expect(footer).toContainText(qualified ? fact : "Multiple notes match");
    await page.screenshot({ path: testInfo.outputPath(`${qualified ? "qualified" : "ambiguous"}-citation.png`) });
    expect(errors).toEqual([]);
  });
}
