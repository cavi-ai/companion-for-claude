import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchObsidianHarness } from "./obsidianHarness";

const OUTPUT = process.env.CC_E2E_OUTPUT_DIR ?? "/private/tmp/claude-companion-research-e2e-results";

interface Surface {
  name: string;
  command: string;
  selector: string;
}

const surfaces: Surface[] = [
  { name: "chat", command: "claude-companion:open-chat", selector: ".cc-chat-root" },
  { name: "inbox", command: "claude-companion:open-source-inbox", selector: ".cc-inbox-view" },
  { name: "related", command: "claude-companion:open-related-notes", selector: ".cc-related-view" },
  { name: "memory", command: "claude-companion:open-memory-view", selector: ".cc-memory-view" },
  { name: "research-desk", command: "claude-companion:open-research-desk", selector: ".cc-research-desk" },
  { name: "research-workbench", command: "claude-companion:open-research-workbench", selector: ".cc-research-workbench" },
];

async function dismissSetupPrompts(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const button = page.getByRole("button", { name: "Not now" }).last();
    if (!await button.isVisible().catch(() => false)) break;
    await button.click();
  }
}

async function openSurface(page: Page, surface: Surface): Promise<Locator> {
  await page.evaluate(async (command) => {
    const app = (window as unknown as { app: { commands: { executeCommandById(id: string): Promise<void> } } }).app;
    await app.commands.executeCommandById(command);
  }, surface.command);
  const root = page.locator(surface.selector).last();
  await expect(root).toBeVisible();
  await dismissSetupPrompts(page);
  return root;
}

async function sizePane(root: Locator, width: number): Promise<void> {
  await root.evaluate((element, paneWidth) => {
    const pane = element.closest(".workspace-split.mod-right-split")
      ?? element.closest(".workspace-leaf")?.parentElement;
    if (!(pane instanceof HTMLElement)) throw new Error("Companion pane container not found");
    pane.style.width = `${paneWidth}px`;
    pane.style.minWidth = `${paneWidth}px`;
    pane.style.maxWidth = `${paneWidth}px`;
    pane.style.flex = `0 0 ${paneWidth}px`;
    pane.style.position = "fixed";
    pane.style.inset = "0 0 0 auto";
    pane.style.zIndex = "20";
  }, width);
}

async function visualIssues(root: Locator): Promise<string[]> {
  return await root.evaluate((element) => {
    const issues: string[] = [];
    const rootRect = element.getBoundingClientRect();
    if (element.scrollWidth > element.clientWidth + 1) {
      issues.push(`root horizontal overflow ${element.scrollWidth - element.clientWidth}px`);
      const offenders = [...element.querySelectorAll("*")]
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.right > rootRect.right + 1)
        .sort((left, right) => right.rect.right - left.rect.right)
        .slice(0, 3);
      for (const { node, rect } of offenders) {
        const label = node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 50) ?? node.className;
        issues.push(`overflow source +${Math.round(rect.right - rootRect.right)}px: ${node.className || node.tagName} ${label}`);
      }
    }

    const visible = (node: Element): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...element.querySelectorAll("button, summary")].filter(visible);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const label = control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 60) ?? control.className;
      if (rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1) {
        issues.push(`control escapes horizontally: ${label}`);
      }
      if (control.scrollHeight > control.clientHeight + 1) {
        issues.push(`control clips text vertically: ${label}`);
      }
      if (control.scrollWidth > control.clientWidth + 1) {
        issues.push(`control clips text horizontally: ${label}`);
      }
    }

    const settingRows = [...element.querySelectorAll(".cc-settings-root .setting-item")].filter(visible);
    for (const row of settingRows) {
      const info = row.querySelector<HTMLElement>(".setting-item-info");
      const control = row.querySelector<HTMLElement>(".setting-item-control");
      if (!info || !control || !visible(info) || !visible(control)) continue;
      const infoRect = info.getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      const sideBySide = Math.abs(infoRect.top - controlRect.top) < Math.min(infoRect.height, controlRect.height);
      if (sideBySide && infoRect.width < 140) {
        issues.push(`setting label column crushed to ${Math.round(infoRect.width)}px: ${info.textContent?.trim().slice(0, 50) ?? "setting"}`);
      }
    }

    const groups = [...element.querySelectorAll(
      ".cc-empty-examples, .cc-context-workspace-actions, .cc-desk-grid, .cc-desk-metrics, .cc-research-metrics, .cc-research-health, .cc-research-actions, .cc-workspace-navigation",
    )].filter(visible);
    for (const group of groups) {
      const children = [...group.children].filter(visible).map((child) => ({
        label: child.getAttribute("aria-label") ?? child.textContent?.trim().slice(0, 40) ?? child.className,
        rect: child.getBoundingClientRect(),
      }));
      for (let left = 0; left < children.length; left += 1) {
        for (let right = left + 1; right < children.length; right += 1) {
          const a = children[left]!;
          const b = children[right]!;
          const width = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
          const height = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));
          if (width * height > 1) issues.push(`siblings overlap: ${a.label} / ${b.label}`);
        }
      }
    }
    return issues;
  });
}

test("primary Companion screens are visually contained at real pane breakpoints", async () => {
  test.setTimeout(120_000);
  const harness = await launchObsidianHarness();
  const { page } = harness;
  const failures: string[] = [];
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const surface of surfaces) {
      const root = await openSurface(page, surface);
      for (const width of [320, 420, 600]) {
        await sizePane(root, width);
        await page.waitForTimeout(100);
        await page.screenshot({ path: `${OUTPUT}/visual-${surface.name}-${width}-light.png` });
        for (const issue of await visualIssues(root)) failures.push(`${surface.name}@${width}: ${issue}`);
      }
    }

    await page.evaluate(() => {
      const app = (window as unknown as { app: { setting: { open(): void; openTabById(id: string): void } } }).app;
      app.setting.open();
      app.setting.openTabById("claude-companion");
    });
    const settings = page.locator(".vertical-tab-content.cc-settings-root");
    await expect(settings).toBeVisible();
    await expect(settings.locator(".setting-item").first()).toBeVisible();
    // Desktop Obsidian keeps a fixed settings navigation rail; below 600px the
    // host shell itself horizontally scrolls. Compact phone settings require
    // Obsidian's native mobile shell rather than viewport-emulating desktop.
    for (const width of [600, 768]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: `${OUTPUT}/visual-settings-${width}-light.png` });
      for (const issue of await visualIssues(settings)) failures.push(`settings@${width}: ${issue}`);
    }

    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 800 });
    const chat = await openSurface(page, surfaces[0]!);
    await sizePane(chat, 320);
    await page.evaluate(() => {
      document.body.classList.remove("theme-light");
      document.body.classList.add("theme-dark");
    });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${OUTPUT}/visual-chat-320-dark.png` });
    for (const issue of await visualIssues(chat)) failures.push(`chat@320-dark: ${issue}`);

    expect(failures, failures.join("\n")).toEqual([]);
  } finally {
    await harness.close();
  }
});
