import { test, expect, type Page, type Locator } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

// Settings-tab regression suite. Catches the two failure classes seen in the
// wild: (1) the tab renders but no control responds ("dead menu"), and (2) a
// structural change re-renders the whole tab, collapsing every accordion and
// resetting scroll.

const TAB = ".vertical-tab-content";

async function openSettingsTab(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const app = (window as unknown as { app: { setting: { open(): void; openTabById(id: string): void } } }).app;
    app.setting.open();
    app.setting.openTabById("claude-companion");
  });
  const tab = page.locator(TAB);
  await expect(tab.locator(".setting-item").first()).toBeVisible();
  return tab;
}

function accordion(page: Page, tab: Locator, title: string): Locator {
  return tab.locator(".cc-accordion").filter({ has: page.locator(".cc-accordion-summary", { hasText: title }) });
}

test("settings tab renders, controls respond, structural changes stay local", async () => {
  const harness = await launchObsidianHarness();
  const { page } = harness;
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  try {
    const tab = await openSettingsTab(page);

    await expect(tab.locator(".cc-settings-group")).toHaveText(["Agent", "Vault intelligence", "Files, memory & privacy"]);
    await expect(tab.locator(".cc-accordion")).toHaveCount(14);
    expect(await tab.locator(".setting-item").count()).toBeGreaterThan(50);
    expect(await tab.locator(".setting-item-control input, .setting-item-control select, .setting-item-control textarea, .setting-item-control .checkbox-container").count()).toBeGreaterThan(40);

    // Controls inside an opened accordion respond to clicks.
    const agent = accordion(page, tab, "Agent (act on your vault)");
    await agent.locator(".cc-accordion-summary").click();
    const toggle = agent.locator(".setting-item-control .checkbox-container").first();
    await expect(toggle).toBeVisible();
    const wasEnabled = await toggle.evaluate((el) => el.classList.contains("is-enabled"));
    await toggle.click();
    await expect(toggle).toHaveClass(wasEnabled ? "checkbox-container" : "checkbox-container is-enabled");
    await toggle.click(); // restore

    // Auth-mode switch swaps the credential field without touching the rest
    // of the tab (groups survive, accordion state survives).
    await tab.locator(".setting-item", { hasText: "Authentication" }).locator("select").selectOption("oauthToken");
    await expect(tab.locator("input[type='password'][placeholder*='sk-ant-oat']")).toBeVisible();
    await expect(tab.locator(".cc-settings-group")).toHaveCount(3);
    await expect(agent).toHaveJSProperty("open", true);
    await tab.locator(".setting-item", { hasText: "Authentication" }).locator("select").selectOption("apiKey");
    await expect(tab.locator("input[type='password'][placeholder*='sk-ant-api']")).toBeVisible();

    // Web-search toggle re-renders only its own accordion: same DOM node,
    // accordion stays open, dependent row appears.
    await agent.evaluate((el) => ((el as unknown as { __probe: string }).__probe = "keep"));
    const webRow = agent.locator(".setting-item", { hasText: "Web search tool" });
    await webRow.locator(".checkbox-container").click();
    await expect(agent.locator(".setting-item", { hasText: "Search engine" })).toBeVisible();
    await expect(agent).toHaveJSProperty("open", true);
    expect(await agent.evaluate((el) => (el as unknown as { __probe?: string }).__probe)).toBe("keep");
    await agent.locator(".setting-item", { hasText: "Web search tool" }).locator(".checkbox-container").click(); // restore

    // MCP client: add + remove a server without the accordion collapsing.
    const mcp = accordion(page, tab, "External tools — MCP client");
    await mcp.locator(".cc-accordion-summary").click();
    const serversBefore = await mcp.locator(".cc-mcp-server").count();
    await mcp.locator("button", { hasText: "Add MCP server" }).click();
    await expect(mcp.locator(".cc-mcp-server")).toHaveCount(serversBefore + 1);
    await expect(mcp).toHaveJSProperty("open", true);
    await mcp.locator("button", { hasText: "Remove" }).last().click();
    await expect(mcp.locator(".cc-mcp-server")).toHaveCount(serversBefore);

    const fatal = consoleErrors.filter((e) => !e.includes("e2e-key") && !e.includes("127.0.0.1"));
    expect(fatal).toEqual([]);
  } finally {
    await harness.close();
  }
});
