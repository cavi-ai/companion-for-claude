import { mkdir } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchObsidianHarness, type ObsidianHarness } from "./obsidianHarness";

const OUTPUT = "/private/tmp/claude-companion-context-e2e-results";
const LONG_FOLDER = "Reference material with a deliberately long folder name";
type Fixture = "empty" | "one" | "automatic" | "dense" | "pending" | "failed" | "long";

test.describe.configure({ mode: "serial" });
let harness: ObsidianHarness;

test.beforeAll(async () => {
  await mkdir(OUTPUT, { recursive: true });
  harness = await launchObsidianHarness();
  await harness.page.evaluate(async () => {
    const app = (window as unknown as {
      app: {
        plugins: { plugins: Record<string, { settings: { context: Record<string, boolean> } }> };
        commands: { executeCommandById(id: string): Promise<void> };
      };
    }).app;
    app.plugins.plugins["claude-companion"].settings.context = {
      activeNote: false,
      selection: false,
      linkedNotes: false,
      searchVault: false,
    };
    await app.commands.executeCommandById("claude-companion:open-chat");
  });
  await expect(harness.page.locator(".cc-chat-root")).toBeVisible();
});

test.afterAll(async () => { await harness?.close(); });

async function setObsidianTheme(page: Page, theme: "theme-light" | "theme-dark"): Promise<void> {
  await page.evaluate((nextTheme) => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(nextTheme);
  }, theme);
}

async function setMobileClass(page: Page, mobile: boolean): Promise<void> {
  await page.evaluate((enabled) => {
    document.body.classList.toggle("is-mobile", enabled);
    const split = document.querySelector<HTMLElement>(".workspace-split.mod-right-split");
    if (!split) throw new Error("Right sidebar is missing");
    split.style.setProperty("display", "flex", "important");
    split.style.setProperty("position", "fixed", "important");
    split.style.setProperty("inset", "0", "important");
    split.style.setProperty("width", "100vw", "important");
    split.style.setProperty("min-width", "0", "important");
    split.style.setProperty("z-index", "100", "important");
  }, mobile);
}

async function seedFixture(page: Page, fixture: Fixture): Promise<void> {
  await page.evaluate(({ name, longFolder }) => {
    const app = (window as unknown as { app: { workspace: { getLeavesOfType(type: string): Array<{ view: unknown }> } } }).app;
    const view = app.workspace.getLeavesOfType("claude-companion-chat")[0]?.view as {
      plugin: { settings: { context: { activeNote: boolean; selection: boolean; linkedNotes: boolean; searchVault: boolean } } };
      attachedPaths: Array<{ kind: "note" | "folder"; path: string }>;
      attachedMedia: Array<{ kind: "pdf" | "image"; label: string; mime: string; path: string }>;
      attachedPages: Array<{ url: string; title?: string; markdown: string; pending?: boolean; error?: string }>;
      lastContextManagerSignature: string;
      renderContextManager(): void;
    };
    if (!view) throw new Error("Chat view is not open");
    const off = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
    view.plugin.settings.context = name === "one"
      ? { ...off, activeNote: true }
      : name === "automatic" || name === "dense"
        ? { activeNote: true, selection: true, linkedNotes: true, searchVault: true }
        : off;
    view.attachedPaths = name === "dense" || name === "long" ? [
      { kind: "note", path: "Research/Alpha/Project.md" },
      { kind: "note", path: `${longFolder}/A very long note title that must truncate without widening the composer.md` },
      { kind: "folder", path: longFolder },
    ] : [];
    view.attachedMedia = name === "dense" ? [
      { kind: "pdf", label: "Study.pdf", mime: "application/pdf", path: `${longFolder}/Study.pdf` },
      { kind: "image", label: "Figure.png", mime: "image/png", path: `${longFolder}/Figure.png` },
    ] : [];
    view.attachedPages = name === "pending"
      ? [{ url: "https://example.test/pending", markdown: "", pending: true }]
      : name === "failed"
        ? [{ url: "https://example.test/failed", markdown: "", error: "The page could not be captured. Check the address and retry." }]
        : name === "dense"
          ? [{ url: "https://example.test/article", title: "Captured article", markdown: "Captured body" }]
          : [];
    view.lastContextManagerSignature = "";
    view.renderContextManager();
  }, { name: fixture, longFolder: LONG_FOLDER });
}

function trigger(page: Page): Locator {
  return page.locator(".cc-chat-root .cc-context-trigger");
}

async function openManager(page: Page): Promise<Locator> {
  const button = trigger(page);
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
  const manager = page.locator(".cc-chat-root").getByRole("dialog", { name: "Message context" });
  await expect(manager).toBeVisible();
  return manager;
}

async function closeManager(page: Page): Promise<void> {
  const manager = page.locator(".cc-chat-root").getByRole("dialog", { name: "Message context" });
  if (await manager.isVisible()) await manager.getByRole("button", { name: "Close message context" }).click();
  await expect(manager).toBeHidden();
  await expect(trigger(page)).toBeFocused();
}

async function expectInsideViewport(locator: Locator, width: number, height: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

function intersectionArea(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

async function expectGeometry(page: Page, width: number, height: number, mobile: boolean): Promise<void> {
  const chat = page.locator(".cc-chat-root");
  const manager = chat.getByRole("dialog", { name: "Message context" });
  await expectNoHorizontalOverflow(chat);
  await expectInsideViewport(manager, width, height);
  expect((await trigger(page).boundingBox())!.height).toBeGreaterThanOrEqual(mobile ? 44 : 36);
  expect((await manager.getByRole("button", { name: "Close message context" }).boundingBox())!.height).toBeGreaterThanOrEqual(mobile ? 44 : 36);
  const rows = manager.locator(".cc-context-row");
  expect((await rows.first().boundingBox())!.height).toBeGreaterThanOrEqual(mobile ? 44 : 36);
  const surfaceBox = (await manager.boundingBox())!;
  const textareaBox = (await chat.locator("textarea").boundingBox())!;
  const sendBox = (await chat.getByRole("button", { name: "Send" }).boundingBox())!;
  if (!mobile) {
    expect(intersectionArea(surfaceBox, textareaBox)).toBe(0);
    expect(intersectionArea(surfaceBox, sendBox)).toBe(0);
  }
}

test("public interaction replaces pills and reuses the existing source picker", async () => {
  const { page } = harness;
  await seedFixture(page, "empty");
  const chat = page.locator(".cc-chat-root");
  await expect(chat.locator(".cc-attach-pill")).toHaveCount(0);
  await expect(trigger(page)).toHaveAttribute("aria-label", "Manage context, 0 items active");

  const manager = await openManager(page);
  await manager.getByLabel("This note").check();
  await expect(trigger(page)).toHaveAttribute("aria-label", "Manage context, 1 item active");
  await manager.getByRole("button", { name: "Add context" }).click();
  await expect(chat.locator(".cc-at-menu")).toBeVisible();
  await expect(chat.locator("textarea")).toBeFocused();
  await chat.locator("textarea").press("Escape");
});

test("dense context stays inside every target pane in light and dark themes", async () => {
  const { page } = harness;
  for (const width of [320, 360, 420, 600, 768]) {
    for (const theme of ["theme-light", "theme-dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await setObsidianTheme(page, theme);
      await setMobileClass(page, width <= 420);
      await seedFixture(page, "dense");
      const manager = await openManager(page);
      await expectGeometry(page, width, 900, width <= 420);
      await page.locator(".cc-chat-root").screenshot({ path: `${OUTPUT}/${theme}-${width}-dense.png` });
      const scroll = manager.locator(".cc-context-scroll");
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(manager.getByRole("button", { name: "Remove Captured article" })).toBeVisible();
      await expect(manager.getByRole("button", { name: "Add context" })).toBeVisible();
      await page.locator(".cc-chat-root").screenshot({ path: `${OUTPUT}/${theme}-${width}-dense-bottom.png` });
      await closeManager(page);
    }
  }
});

test("canonical empty, automatic, long, pending, and failed states remain readable", async () => {
  const { page } = harness;
  await page.setViewportSize({ width: 768, height: 900 });
  await setMobileClass(page, false);
  await setObsidianTheme(page, "theme-light");
  for (const fixture of ["empty", "one", "automatic", "long", "pending", "failed"] as const) {
    await seedFixture(page, fixture);
    if (fixture === "empty") {
      await expect(trigger(page)).toContainText("Add context");
      await page.locator(".cc-chat-root").screenshot({ path: `${OUTPUT}/${fixture}.png` });
      continue;
    }
    const manager = await openManager(page);
    await expectNoHorizontalOverflow(page.locator(".cc-chat-root"));
    if (fixture === "long") {
      const longName = "A very long note title that must truncate without widening the composer";
      await expect(manager.getByTitle(longName, { exact: true })).toBeVisible();
    }
    if (fixture === "pending") await expect(manager.getByRole("status")).toContainText("Pending capture");
    if (fixture === "failed") {
      await expect(manager.getByRole("alert")).toContainText("could not be captured");
      await expect(manager.getByRole("button", { name: "Retry example.test/failed" })).toBeVisible();
      await expect(manager.getByRole("button", { name: "Remove example.test/failed" })).toBeVisible();
    }
    await page.locator(".cc-chat-root").screenshot({ path: `${OUTPUT}/${fixture}.png` });
    await closeManager(page);
  }
});
